import { cookies } from 'next/headers';

// The web app stores the JWT access token in an httpOnly cookie and forwards it
// as a Bearer token on server-side API calls. (A production app would also wire
// the refresh cookie to silently re-mint expired access tokens.)
export const TOKEN_COOKIE = 'atlas_token';

// Next 15+ made cookies() async.
export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(TOKEN_COOKIE)?.value;
}
