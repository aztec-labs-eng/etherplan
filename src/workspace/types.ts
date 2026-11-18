import type { Artifacts } from '../artifacts/types.ts';
import type {
  ApplyInput,
  DeploymentScope,
  JournalCipher,
  JournalStore,
  LockProvider,
  PlanStore,
  StateStore,
} from '../execution/types.ts';
import type { Plan, PlanSignerInput } from '../planning/types.ts';
import type { Client, Hash, ResourceId } from '../types.ts';

export interface WorkspaceBackend {
  identity: string;
  coordinationId: string;
  scope: DeploymentScope;
  stateStore: StateStore;
  journalStore: JournalStore;
  lockProvider: LockProvider;
  journalCipher: JournalCipher;
  planStore?: PlanStore | null;
  confirmations: number;
}
export interface WorkspaceUnitSource {
  projectDirectory: string;
  workspace: string;
  varFiles: string[];
  vars: string[];
  backendFile?: string;
  stateFile?: string;
  journalFile?: string;
}
export interface WorkspaceUnit {
  source?: WorkspaceUnitSource;
  key: string;
  project: string;
  workspace: string;
  spec: unknown;
  artifacts: Artifacts;
  stateFile?: string;
  journalFile?: string;
  backend?: WorkspaceBackend;
}
export interface WorkspaceLink {
  consumer: { unit: string; resource: ResourceId; location?: string };
  producer: { unit: string; resource: ResourceId };
}
export interface WorkspaceMetadata {
  formatVersion: 1;
  units: {
    source?: WorkspaceUnitSource;
    key: string;
    project: string;
    workspace: string;
    specHash: Hash;
    artifactHashes: Record<string, Hash>;
    stateHash: Hash;
    storage:
      | { stateFile: string; journalFile: string }
      | { scope: DeploymentScope; backendIdentity: string };
  }[];
  links: WorkspaceLink[];
}
export interface CreateWorkspacePlanInput {
  units: WorkspaceUnit[];
  links?: WorkspaceLink[];
  client: Client;
  pipeline: PlanSignerInput;
  maxSpendWei: string | bigint;
}
export type ApplyWorkspacePlanInput = Omit<
  ApplyInput,
  | 'spec'
  | 'artifacts'
  | 'stateFile'
  | 'journalFile'
  | 'scope'
  | 'stateStore'
  | 'journalStore'
  | 'journalCipher'
  | 'lockProvider'
> & { units: WorkspaceUnit[]; plan: Plan };
