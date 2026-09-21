/** Native OMS Beads persistence contracts. */

export const NATIVE_BEADS_SCHEMA_VERSION = 4;

export const BEADS_ISSUE_STATUSES = ["open", "in_progress", "closed", "deferred"] as const;
export type BeadsIssueStatus = (typeof BEADS_ISSUE_STATUSES)[number];

export type BeadsPriority = 0 | 1 | 2 | 3 | 4;

export const BEADS_ISSUE_TYPES = ["bug", "feature", "task", "epic", "chore"] as const;
export type BeadsIssueType = (typeof BEADS_ISSUE_TYPES)[number];

export const BLOCKING_DEPENDENCY_TYPES = ["blocks", "conditional-blocks", "waits-for"] as const;

export interface BeadsDependency {
	issue_id: string;
	depends_on_id: string;
	type: string;
	created_at: string;
	created_by?: string;
}

/** Stable issue shape exposed by the model-facing tool and JSONL interchange. */
export interface BeadsIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type: string;
	assignee?: string;
	owner?: string;
	parent?: string | null;
	labels?: string[];
	dependencies?: BeadsDependency[];
	dependency_count?: number;
	dependent_count?: number;
	blocked_by?: Array<string | { id: string; title?: string; status?: string }>;
	description?: string;
	acceptance_criteria?: string;
	design?: string;
	notes?: string;
	created_at?: string;
	created_by?: string;
	updated_at?: string;
	started_at?: string;
	closed_at?: string;
	close_reason?: string;
}

export interface BeadsMemory {
	key: string;
	value: string;
	created_at: string;
	updated_at: string;
}

export interface BeadsNote {
	issue_id?: string;
	key: string;
	text: string;
	created_at: string;
	updated_at: string;
	created_by?: string;
	deleted_at?: string;
}

export interface SetBeadsNoteInput {
	issueId?: string;
	key: string;
	text: string;
	actor: string;
}

export interface BeadsNoteStamp {
	count: number;
	maxUpdatedAt?: string;
}

export interface CreateBeadsIssueInput {
	title: string;
	description?: string;
	issueType?: BeadsIssueType;
	priority?: BeadsPriority;
	parent?: string;
	deps?: string[];
	design?: string;
	acceptance?: string;
	actor: string;
}

export interface UpdateBeadsIssueInput {
	id: string;
	claim?: boolean;
	title?: string;
	description?: string;
	notes?: string;
	design?: string;
	acceptance?: string;
	priority?: BeadsPriority;
	actor: string;
}

export interface BeadsStats {
	total: number;
	open: number;
	inProgress: number;
	closed: number;
	deferred: number;
	ready: number;
	blocked: number;
	dependencies: number;
	memories: number;
	cycles: number;
}

export interface BeadsMergeResult {
	issues: number;
	dependencies: number;
	dependencyConflicts: number;
	memories: number;
	notes: number;
}
