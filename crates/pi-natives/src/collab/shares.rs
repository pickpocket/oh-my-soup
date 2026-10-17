//! Bounded opaque share storage with durable creation times and OS random IDs.

use std::{
	collections::{BTreeSet, HashMap},
	fs::{self, File, OpenOptions},
	io::{self, Read, Write},
	path::{Path, PathBuf},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use parking_lot::Mutex;

pub const MAX_BODY_BYTES: usize = 1_048_576;
pub const MIN_BODY_BYTES: usize = 12 + 1 + 16;
const MAGIC: &[u8; 8] = b"OMSSHAR2";
const HEADER_BYTES: usize = 24;

struct StoredBlob {
	created_ms: u64,
	serial:     u64,
	length:     usize,
	// Disk-backed stores keep only metadata in memory.
	memory:     Option<Bytes>,
}

#[derive(Default)]
struct Inner {
	blobs:       HashMap<String, StoredBlob>,
	order:       BTreeSet<(u64, u64, String)>,
	next_serial: u64,
	closed:      bool,
}

pub struct ShareStore {
	inner:          Mutex<Inner>,
	ttl_ms:         u64,
	max_blobs:      usize,
	directory:      Option<PathBuf>,
	directory_lock: Mutex<Option<File>>,
}

#[derive(Debug)]
pub enum ShareError {
	TooSmall,
	TooLarge,
	Storage(io::Error),
}

impl From<io::Error> for ShareError {
	fn from(error: io::Error) -> Self {
		Self::Storage(error)
	}
}

pub fn is_valid_share_id(id: &str) -> bool {
	(8..=64).contains(&id.len())
		&& id
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn now_ms() -> io::Result<u64> {
	let elapsed = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(io::Error::other)?;
	u64::try_from(elapsed.as_millis()).map_err(io::Error::other)
}

impl ShareStore {
	pub fn open(ttl: Duration, max_blobs: usize, directory: Option<PathBuf>) -> io::Result<Self> {
		Self::open_at(ttl, max_blobs, directory, now_ms()?)
	}

	fn open_at(
		ttl: Duration,
		max_blobs: usize,
		directory: Option<PathBuf>,
		now: u64,
	) -> io::Result<Self> {
		let ttl_ms = u64::try_from(ttl.as_millis()).map_err(io::Error::other)?;
		if ttl_ms == 0 || max_blobs == 0 {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"share TTL and capacity must be positive",
			));
		}
		let directory = directory
			.map(|directory| {
				fs::create_dir_all(&directory)?;
				fs::canonicalize(directory)
			})
			.transpose()?;
		let directory_lock = directory.as_deref().map(lock_directory).transpose()?;
		let store = Self {
			inner: Mutex::new(Inner::default()),
			ttl_ms,
			max_blobs,
			directory,
			directory_lock: Mutex::new(directory_lock),
		};
		store.load(now)?;
		Ok(store)
	}

	pub fn close(&self) {
		let mut inner = self.inner.lock();
		inner.closed = true;
		inner.blobs.clear();
		inner.order.clear();
		drop(self.directory_lock.lock().take());
	}

	fn load(&self, now: u64) -> io::Result<()> {
		let Some(directory) = &self.directory else {
			return Ok(());
		};
		let mut inner = self.inner.lock();
		for entry in fs::read_dir(directory)? {
			let entry = entry?;
			if !entry.file_type()?.is_file() {
				continue;
			}
			let path = entry.path();
			let Some(id) = path
				.file_stem()
				.and_then(|id| id.to_str())
				.filter(|id| is_valid_share_id(id))
			else {
				continue;
			};
			if path.extension().and_then(|extension| extension.to_str()) == Some("tmp")
				&& id.len() == 23
				&& id.starts_with('_')
			{
				fs::remove_file(&path)?;
				continue;
			}
			if path.extension().and_then(|extension| extension.to_str()) != Some("bin") {
				continue;
			}
			let metadata = entry.metadata()?;
			let length = metadata.len();
			if !(MIN_BODY_BYTES as u64 + HEADER_BYTES as u64
				..=MAX_BODY_BYTES as u64 + HEADER_BYTES as u64)
				.contains(&length)
			{
				fs::remove_file(&path)?;
				continue;
			}
			let mut header = [0; HEADER_BYTES];
			File::open(&path)?.read_exact(&mut header)?;
			if &header[..8] != MAGIC {
				fs::remove_file(&path)?;
				continue;
			}
			let created_ms = u64::from_be_bytes(header[8..16].try_into().expect("timestamp header"));
			let serial = u64::from_be_bytes(header[16..].try_into().expect("serial header"));
			inner.next_serial = inner.next_serial.max(
				serial
					.checked_add(1)
					.ok_or_else(|| io::Error::other("share serial exhausted"))?,
			);
			if now.saturating_sub(created_ms) >= self.ttl_ms {
				fs::remove_file(&path)?;
				continue;
			}
			inner.order.insert((created_ms, serial, id.to_owned()));
			inner.blobs.insert(id.to_owned(), StoredBlob {
				created_ms,
				serial,
				length: length as usize - HEADER_BYTES,
				memory: None,
			});
			while inner.blobs.len() > self.max_blobs {
				self.remove_oldest(&mut inner)?;
			}
		}
		Ok(())
	}

	pub fn put(&self, body: Bytes) -> Result<String, ShareError> {
		self.put_at(body, now_ms()?)
	}

	fn put_at(&self, body: Bytes, now: u64) -> Result<String, ShareError> {
		if body.len() < MIN_BODY_BYTES {
			return Err(ShareError::TooSmall);
		}
		if body.len() > MAX_BODY_BYTES {
			return Err(ShareError::TooLarge);
		}
		let mut inner = self.inner.lock();
		self.prune_locked(&mut inner, now)?;
		let serial = inner.next_serial;
		inner.next_serial = serial
			.checked_add(1)
			.ok_or_else(|| io::Error::other("share serial exhausted"))?;
		let mut id = String::with_capacity(23);
		for _ in 0..8 {
			let mut random = [0; 16];
			getrandom::fill(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
			// The viewer treats pure hex IDs as GitHub gists. This prefix also
			// guarantees every server ID has 128 OS-generated random bits.
			id.clear();
			id.push('_');
			URL_SAFE_NO_PAD.encode_string(random, &mut id);
			if inner.blobs.contains_key(&id) {
				continue;
			}
			if let Some(directory) = &self.directory {
				match persist(directory, &id, now, serial, &body) {
					Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
					result => result?,
				}
			}
			while inner.blobs.len() >= self.max_blobs {
				if let Err(error) = self.remove_oldest(&mut inner) {
					if let Some(directory) = &self.directory {
						let _ = fs::remove_file(directory.join(format!("{id}.bin")));
					}
					return Err(error.into());
				}
			}
			inner.order.insert((now, serial, id.clone()));
			inner.blobs.insert(id.clone(), StoredBlob {
				created_ms: now,
				serial,
				length: body.len(),
				memory: self.directory.is_none().then_some(body),
			});
			return Ok(id);
		}
		Err(io::Error::other("unable to allocate a unique share ID").into())
	}

	pub fn get(&self, id: &str) -> io::Result<Option<Bytes>> {
		self.get_at(id, now_ms()?)
	}

	fn get_at(&self, id: &str, now: u64) -> io::Result<Option<Bytes>> {
		if !is_valid_share_id(id) {
			return Ok(None);
		}
		let mut inner = self.inner.lock();
		self.prune_locked(&mut inner, now)?;
		let Some(blob) = inner.blobs.get(id) else {
			return Ok(None);
		};
		if let Some(body) = &blob.memory {
			return Ok(Some(body.clone()));
		}
		let directory = self.directory.as_ref().expect("disk-backed blob");
		let path = directory.join(format!("{id}.bin"));
		// Never follow a symlink introduced after startup, even to a valid blob.
		let metadata = match fs::symlink_metadata(&path) {
			Ok(metadata) => metadata,
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				self.remove_locked(&mut inner, id)?;
				return Ok(None);
			},
			Err(error) => return Err(error),
		};
		if !metadata.is_file() || metadata.len() != (blob.length + HEADER_BYTES) as u64 {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "share file was replaced"));
		}
		let mut file = File::open(path)?;
		let mut header = [0; HEADER_BYTES];
		file.read_exact(&mut header)?;
		if &header[..8] != MAGIC
			|| u64::from_be_bytes(header[8..16].try_into().expect("timestamp header"))
				!= blob.created_ms
			|| u64::from_be_bytes(header[16..].try_into().expect("serial header")) != blob.serial
		{
			return Err(io::Error::new(io::ErrorKind::InvalidData, "share header was replaced"));
		}
		let mut body = vec![0; blob.length];
		file.read_exact(&mut body)?;
		Ok(Some(Bytes::from(body)))
	}

	pub fn delete(&self, id: &str) -> io::Result<bool> {
		if !is_valid_share_id(id) {
			return Ok(false);
		}
		let mut inner = self.inner.lock();
		self.prune_locked(&mut inner, now_ms()?)?;
		self.remove_locked(&mut inner, id)
	}

	pub fn size(&self) -> usize {
		let Ok(now) = now_ms() else {
			return 0;
		};
		let inner = self.inner.lock();
		inner
			.blobs
			.values()
			.filter(|blob| now.saturating_sub(blob.created_ms) < self.ttl_ms)
			.count()
	}

	pub fn prune(&self) -> io::Result<()> {
		self.prune_locked(&mut self.inner.lock(), now_ms()?)
	}

	fn prune_locked(&self, inner: &mut Inner, now: u64) -> io::Result<()> {
		if inner.closed {
			return Err(io::Error::new(io::ErrorKind::BrokenPipe, "share store is closed"));
		}
		while let Some((created, _, id)) = inner.order.first() {
			if now.saturating_sub(*created) < self.ttl_ms {
				break;
			}
			let id = id.clone();
			self.remove_locked(inner, &id)?;
		}
		Ok(())
	}

	fn remove_oldest(&self, inner: &mut Inner) -> io::Result<()> {
		let Some((_, _, id)) = inner.order.first() else {
			return Ok(());
		};
		let id = id.clone();
		self.remove_locked(inner, &id)?;
		Ok(())
	}

	fn remove_locked(&self, inner: &mut Inner, id: &str) -> io::Result<bool> {
		let Some(blob) = inner.blobs.get(id) else {
			return Ok(false);
		};
		if let Some(directory) = &self.directory {
			match fs::remove_file(directory.join(format!("{id}.bin"))) {
				Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
				_ => {},
			}
		}
		inner
			.order
			.remove(&(blob.created_ms, blob.serial, id.to_owned()));
		inner.blobs.remove(id);
		Ok(true)
	}
}

fn lock_directory(directory: &Path) -> io::Result<File> {
	let path = directory.join(".oms-collab.lock");
	if fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file()) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"share directory lock must be a regular file",
		));
	}
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.open(path)?;
	file.try_lock().map_err(io::Error::other)?;
	Ok(file)
}

fn persist(directory: &Path, id: &str, created: u64, serial: u64, body: &[u8]) -> io::Result<()> {
	let path = directory.join(format!("{id}.bin"));
	if path.try_exists()? {
		return Err(io::ErrorKind::AlreadyExists.into());
	}
	let temporary = directory.join(format!("{id}.tmp"));
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(0o600);
	}
	let mut file = options.open(&temporary)?;
	let mut published = false;
	let result = (|| {
		file.write_all(MAGIC)?;
		file.write_all(&created.to_be_bytes())?;
		file.write_all(&serial.to_be_bytes())?;
		file.write_all(body)?;
		file.sync_all()?;
		drop(file);
		fs::rename(&temporary, &path)?;
		published = true;
		#[cfg(unix)]
		File::open(directory)?.sync_all()?;
		Ok(())
	})();
	if result.is_err() {
		let _ = fs::remove_file(temporary);
		if published {
			let _ = fs::remove_file(path);
		}
	}
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	struct TestDirectory(PathBuf);
	impl TestDirectory {
		fn new() -> Self {
			let mut random = [0; 16];
			getrandom::fill(&mut random).unwrap();
			let path =
				std::env::temp_dir().join(format!("oms-collab-{}", URL_SAFE_NO_PAD.encode(random)));
			fs::create_dir(&path).unwrap();
			Self(path)
		}
	}
	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn exact_size_bounds_and_unpredictable_non_gist_ids() {
		let store = ShareStore::open(Duration::from_secs(60), 2, None).unwrap();
		assert!(matches!(
			store.put(Bytes::from(vec![0; MIN_BODY_BYTES - 1])),
			Err(ShareError::TooSmall)
		));
		assert!(matches!(
			store.put(Bytes::from(vec![0; MAX_BODY_BYTES + 1])),
			Err(ShareError::TooLarge)
		));
		let minimum = store.put(Bytes::from(vec![1; MIN_BODY_BYTES])).unwrap();
		let maximum = store.put(Bytes::from(vec![2; MAX_BODY_BYTES])).unwrap();
		assert_ne!(minimum, maximum);
		assert_eq!(minimum.len(), 23);
		assert!(minimum.starts_with('_') && is_valid_share_id(&minimum));
		assert_eq!(store.get(&minimum).unwrap().unwrap().len(), MIN_BODY_BYTES);
		assert_eq!(store.get(&maximum).unwrap().unwrap().len(), MAX_BODY_BYTES);
		let first = store.get(&minimum).unwrap().unwrap();
		let second = store.get(&minimum).unwrap().unwrap();
		assert_eq!(first.as_ptr(), second.as_ptr(), "in-memory reads do not copy ciphertext");
	}

	#[test]
	fn ttl_boundary_capacity_and_deletion_do_not_resurrect_shares() {
		let store = ShareStore::open(Duration::from_millis(100), 2, None).unwrap();
		let one = store.put_at(Bytes::from(vec![1; 32]), 1_000).unwrap();
		let two = store.put_at(Bytes::from(vec![2; 32]), 1_001).unwrap();
		assert!(store.get_at(&one, 1_099).unwrap().is_some());
		assert!(store.get_at(&one, 1_100).unwrap().is_none(), "expires exactly at TTL");
		assert!(store.get_at(&two, 1_100).unwrap().is_some());
		let three = store.put_at(Bytes::from(vec![3; 32]), 1_100).unwrap();
		let four = store.put_at(Bytes::from(vec![4; 32]), 1_101).unwrap();
		assert!(store.get_at(&two, 1_101).unwrap().is_none());
		assert!(store.get_at(&three, 1_101).unwrap().is_some());
		assert!(store.remove_locked(&mut store.inner.lock(), &four).unwrap());
		assert!(store.get_at(&four, 1_101).unwrap().is_none());
		assert!(store.get_at("../../secret", 1_101).unwrap().is_none());
	}

	#[test]
	fn persisted_creation_time_capacity_and_deletion_survive_restart() {
		let directory = TestDirectory::new();
		let now = 100_000;
		let store =
			ShareStore::open_at(Duration::from_secs(60), 2, Some(directory.0.clone()), now).unwrap();
		let old = store
			.put_at(Bytes::from(vec![1; 32]), now - 59_000)
			.unwrap();
		let new = store.put_at(Bytes::from(vec![2; 32]), now).unwrap();
		drop(store);
		let restored =
			ShareStore::open_at(Duration::from_secs(60), 2, Some(directory.0.clone()), now).unwrap();
		assert_eq!(restored.get_at(&new, now).unwrap().unwrap(), Bytes::from(vec![2; 32]));
		assert!(restored.get_at(&old, now + 1_000).unwrap().is_none());
		assert!(!directory.0.join(format!("{old}.bin")).exists());
		assert!(
			restored
				.remove_locked(&mut restored.inner.lock(), &new)
				.unwrap()
		);
		drop(restored);
		let restored =
			ShareStore::open_at(Duration::from_secs(60), 1, Some(directory.0.clone()), now).unwrap();
		assert_eq!(restored.size(), 0);
		let first = restored.put_at(Bytes::from(vec![3; 32]), now).unwrap();
		let second = restored.put_at(Bytes::from(vec![4; 32]), now).unwrap();
		assert!(restored.get_at(&first, now).unwrap().is_none());
		assert!(!directory.0.join(format!("{first}.bin")).exists());
		assert!(restored.get_at(&second, now).unwrap().is_some());
	}

	#[test]
	fn disk_directory_is_exclusive_and_close_releases_it_without_deleting_shares() {
		let directory = TestDirectory::new();
		let store = ShareStore::open(Duration::from_secs(60), 1, Some(directory.0.clone())).unwrap();
		let id = store.put(Bytes::from(vec![5; 32])).unwrap();
		assert!(ShareStore::open(Duration::from_secs(60), 1, Some(directory.0.clone())).is_err());
		store.close();
		assert_eq!(store.size(), 0);
		assert!(store.put(Bytes::from(vec![6; 32])).is_err());
		let reopened =
			ShareStore::open(Duration::from_secs(60), 1, Some(directory.0.clone())).unwrap();
		assert_eq!(reopened.get(&id).unwrap().unwrap(), Bytes::from(vec![5; 32]));
	}

	#[test]
	fn corrupt_owned_files_and_unrelated_files_are_handled_deliberately() {
		let directory = TestDirectory::new();
		fs::write(directory.0.join("_corrupt_blob.bin"), vec![0; 100]).unwrap();
		fs::write(directory.0.join("keep.txt"), "not ours").unwrap();
		let store = ShareStore::open(Duration::from_secs(60), 1, Some(directory.0.clone())).unwrap();
		assert_eq!(store.size(), 0);
		assert!(!directory.0.join("_corrupt_blob.bin").exists());
		assert!(directory.0.join("keep.txt").exists());
	}
}
