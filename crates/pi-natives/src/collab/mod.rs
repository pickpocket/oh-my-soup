//! Native bindings for the reusable collaboration relay and encrypted share
//! server.
//!
//! The standalone executable imports the same core without linking N-API. HTTP
//! and RFC 6455 are implemented by Hyper/Axum/Tungstenite, not a second parser.

mod core;
mod relay;
mod shares;

use std::{io, path::PathBuf, time::Duration};

use napi_derive::napi;

pub use self::core::{CollabServerConfig, CollabServerCore};

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NativeCollabServerOptions {
	pub port:                Option<f64>,
	pub hostname:            Option<String>,
	pub static_dir:          Option<String>,
	pub share_dir:           Option<String>,
	pub share_ttl_ms:        Option<f64>,
	pub share_max_blobs:     Option<f64>,
	pub max_rooms:           Option<f64>,
	pub max_guests_per_room: Option<f64>,
}

impl TryFrom<NativeCollabServerOptions> for CollabServerConfig {
	type Error = io::Error;

	fn try_from(options: NativeCollabServerOptions) -> io::Result<Self> {
		let mut config = Self::default();
		if let Some(port) = options.port {
			if !port.is_finite() || port.fract() != 0.0 || !(0.0..=65_535.0).contains(&port) {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					"port must be an integer between 0 and 65535",
				));
			}
			config.port = port as u16;
		}
		if let Some(hostname) = options.hostname {
			config.hostname = hostname;
		}
		config.static_dir = options.static_dir.map(PathBuf::from);
		config.share_dir = options.share_dir.map(PathBuf::from);
		if let Some(ms) = options.share_ttl_ms {
			if !ms.is_finite() || ms.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&ms) {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					"shareTtlMs must be a positive safe integer",
				));
			}
			config.share_ttl = Duration::from_millis(ms as u64);
		}
		for (value, name, target) in [
			(options.share_max_blobs, "shareMaxBlobs", &mut config.share_max_blobs),
			(options.max_rooms, "maxRooms", &mut config.max_rooms),
			(options.max_guests_per_room, "maxGuestsPerRoom", &mut config.max_guests_per_room),
		] {
			if let Some(value) = value {
				if !value.is_finite()
					|| value.fract() != 0.0
					|| !(1.0..=f64::from(u32::MAX)).contains(&value)
				{
					return Err(io::Error::new(
						io::ErrorKind::InvalidInput,
						format!("{name} must be a positive uint32 integer"),
					));
				}
				*target = value as usize;
			}
		}
		config.validate()?;
		Ok(config)
	}
}

#[napi]
pub struct NativeCollabServer {
	core: CollabServerCore,
}

#[napi]
impl NativeCollabServer {
	#[napi(constructor)]
	pub fn new(options: Option<NativeCollabServerOptions>) -> napi::Result<Self> {
		let config = CollabServerConfig::try_from(options.unwrap_or_default())
			.map_err(|error| napi::Error::from_reason(error.to_string()))?;
		let core = CollabServerCore::start(config).map_err(|error| {
			napi::Error::from_reason(format!("Failed to start collab server: {error}"))
		})?;
		Ok(Self { core })
	}

	#[napi(getter)]
	pub fn port(&self) -> u32 {
		u32::from(self.core.port())
	}

	#[napi(getter)]
	pub fn url(&self) -> String {
		self.core.url().to_owned()
	}

	#[napi(getter, js_name = "roomCount")]
	pub fn room_count(&self) -> u32 {
		self.core.room_count() as u32
	}

	#[napi(getter, js_name = "shareCount")]
	pub fn share_count(&self) -> u32 {
		self.core.share_count() as u32
	}

	#[napi]
	pub fn close(&self) {
		self.core.close();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn options_reject_truncation_and_coercion() {
		for port in [-1.0, 0.5, 65_536.0, f64::NAN, f64::INFINITY] {
			assert!(
				CollabServerConfig::try_from(NativeCollabServerOptions {
					port: Some(port),
					..Default::default()
				})
				.is_err()
			);
		}
		for ttl in [0.0, -1.0, 0.5, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
			assert!(
				CollabServerConfig::try_from(NativeCollabServerOptions {
					share_ttl_ms: Some(ttl),
					..Default::default()
				})
				.is_err()
			);
		}
		assert!(
			CollabServerConfig::try_from(NativeCollabServerOptions {
				max_rooms: Some(0.0),
				..Default::default()
			})
			.is_err()
		);
		assert_eq!(
			CollabServerConfig::try_from(NativeCollabServerOptions {
				port: Some(0.0),
				..Default::default()
			})
			.unwrap()
			.port,
			0
		);
	}
}
