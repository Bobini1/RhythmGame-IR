export interface TachiUser {
	_id: string;
	token: string;
	userID: number;
	identifier: string;
	permissions: {
		submit_score: boolean;
	};
	fromAPIClient: string;
}