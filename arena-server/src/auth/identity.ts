export type ArenaIdentity = Readonly<{
	userId: string;
	displayName: string;
	avatarUrl: string | null;
}>;

export type VerifiedArenaTicket = Readonly<{
	identity: ArenaIdentity;
	emailVerified: boolean;
	jti: string;
	issuedAt: Date;
	expiresAt: Date;
	protocolMajor: 1;
	protocolMinor: number;
}>;
