const CONTROLLER = '/api';
export const Locale = `${CONTROLLER}/locale`;
export const ManageCookies = `${CONTROLLER}/manage-cookies`;
export const Health = `${CONTROLLER}/health`;
export const DbHealth = `${CONTROLLER}/health/db`;
export const Demo = `${CONTROLLER}/demo`;
export const Scores = `${CONTROLLER}/scores`;
export const User = `${CONTROLLER}/user`;
export const userScores = (userId: string) => `${CONTROLLER}/user/${userId}/scores`;
