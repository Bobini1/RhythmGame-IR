const CONTROLLER = '/api';

// Utility / internal routes
export const Locale = `${CONTROLLER}/locale`;
export const ManageCookies = `${CONTROLLER}/manage-cookies`;
export const Health = `${CONTROLLER}/health`;
export const DbHealth = `${CONTROLLER}/health/db`;
export const Demo = `${CONTROLLER}/demo`;

// Resource endpoints
export const chart = (md5: string) => `${CONTROLLER}/charts/${md5}`;
export const userById = (id: string) => `${CONTROLLER}/users/${id}`;
export const score = (guid: string) => `${CONTROLLER}/scores/${encodeURIComponent(guid)}`;

// Collection endpoints
export const Scores = `${CONTROLLER}/scores`;
export const Charts = `${CONTROLLER}/charts`;
export const Users = `${CONTROLLER}/users`;
export const ScoreSummaries = `${CONTROLLER}/score-summaries`;

// Mutation endpoints (auth required)
export const ScoresBulk = `${CONTROLLER}/scores/bulk`;
export const ScoresUnknown = `${CONTROLLER}/scores/unknown`;
export const ScoresMissing = `${CONTROLLER}/scores/missing`;
