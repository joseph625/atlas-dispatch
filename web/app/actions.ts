'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { TOKEN_COOKIE } from '@/lib/session';
import { login as apiLogin, retryWorkItem } from '@/lib/api';

// Shared demo password for the one-click account picker (see seed / .env).
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'password';

export async function login(formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const slug = String(formData.get('slug') ?? '');
  const password = String(formData.get('password') ?? DEMO_PASSWORD);
  if (!email) return;

  const { accessToken } = await apiLogin(email, password);
  (await cookies()).set(TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
  redirect(slug ? `/w/${slug}/events` : '/');
}

export async function logout() {
  (await cookies()).delete(TOKEN_COOKIE);
  redirect('/');
}

export async function retryAction(slug: string, id: string) {
  await retryWorkItem(slug, id);
  revalidatePath(`/w/${slug}/events`);
  revalidatePath(`/w/${slug}/events/${id}`);
}
