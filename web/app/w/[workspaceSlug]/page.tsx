import { redirect } from 'next/navigation';

export default async function WorkspaceIndex({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  redirect(`/w/${workspaceSlug}/events`);
}
