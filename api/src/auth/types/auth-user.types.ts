// Membership claims are embedded in the access token so tenant checks never hit
// the DB per request. They refresh when a new access token is minted.
export interface MembershipClaim {
  workspaceId: string;
  slug: string;
  name: string;
  role: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  permissions: string[];
  memberships: MembershipClaim[];
}

export type JwtPayload = AuthUser;
