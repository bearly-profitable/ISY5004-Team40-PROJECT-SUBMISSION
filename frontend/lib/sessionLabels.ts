import { supabase } from './supabase';

/** A signed-in user's own name and star for a backend session (public.session_labels). */
export interface SessionLabel {
  title: string | null;
  favourite: boolean;
}

export async function fetchSessionLabels(): Promise<Record<string, SessionLabel>> {
  if (!supabase) return {};
  const { data, error } = await supabase.from('session_labels').select('job_id, title, favourite');
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((r) => [r.job_id as string, { title: r.title, favourite: r.favourite }]));
}

export async function saveSessionLabel(userId: string, jobId: string, label: SessionLabel): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('session_labels')
    .upsert({ user_id: userId, job_id: jobId, title: label.title?.trim() || null, favourite: label.favourite });
  if (error) throw new Error(error.message);
}

export async function deleteSessionLabel(jobId: string): Promise<void> {
  if (!supabase) return;
  await supabase.from('session_labels').delete().eq('job_id', jobId);
}
