import type { IceServer } from '../shared/types';
import type { Limits } from '../worker/config';

export interface PublicConfig {
  admin: boolean; limits: Limits; stunServers: IceServer[]; r2Configured: boolean;
  turnConfigured: boolean; turnMissing: string[]; challengeRequired: boolean; turnstileSiteKey?: string;
}
