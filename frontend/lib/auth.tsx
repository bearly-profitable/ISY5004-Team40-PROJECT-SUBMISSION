import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { claimAnonymousData, getClientId } from './analysisApi';
import { applyLook, type Profile, type ProfilePatch } from './profile';

export interface AuthState {
  user: User | null;
  profile: Profile | null;
  /** Set when the profile table can't be read (e.g. migration not run yet). */
  profileError: string | null;
  loading: boolean;
  enabled: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (patch: ProfilePatch) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
  /** Back to a Lumi badge (or to `url`, e.g. the Google photo); deletes an uploaded file. */
  setAvatarUrl: (url: string | null) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const AVATAR_BUCKET = 'avatars';

/** Centre-crop to a 256px square WebP: small enough for the 2 MB bucket limit
 *  and plenty for a badge. */
async function toAvatarBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image.');
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob) throw new Error('Could not process that image.');
  return blob;
}

/** Storage path of an avatar we host, so the old file can be removed on replace. */
function ownAvatarPath(url: string | null): string | null {
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const i = url?.indexOf(marker) ?? -1;
  return url && i >= 0 ? decodeURIComponent(url.slice(i + marker.length).split('?')[0]) : null;
}

function describeProfileError(error: { code?: string; message: string }): string {
  // Table missing: PostgREST reports 42P01 / PGRST205.
  if (error.code === '42P01' || error.code === 'PGRST205') {
    return 'Profiles are not set up in Supabase yet: run supabase/migrations/20260926000000_profiles.sql.';
  }
  return error.message;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!supabase);
  // False until the stored session has been read; before that "no user" only
  // means "don't know yet", which must not reset the cached look.
  const [sessionChecked, setSessionChecked] = useState(!supabase);
  const profileRef = useRef<Profile | null>(null);
  profileRef.current = profile;

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setSessionChecked(true);
      if (!data.session) setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Token refreshes re-emit the same user; keep the object stable then.
      setUser((prev) => (prev?.id === session?.user?.id ? prev : session?.user ?? null));
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // Load (or create) the profile whenever the signed-in user changes.
  useEffect(() => {
    if (!supabase || !sessionChecked) return;
    if (!user) {
      setProfile(null);
      setProfileError(null);
      applyLook('lumi', 'classic');
      return;
    }
    let alive = true;
    (async () => {
      setLoading(true);
      // Sessions made on this browser while signed out move into the account,
      // once per account + browser. Awaited so the first session list after
      // login already includes them.
      const claimKey = `lumina-claimed:${user.id}:${getClientId()}`;
      if (!localStorage.getItem(claimKey)) {
        try {
          await claimAnonymousData();
          localStorage.setItem(claimKey, '1');
        } catch { /* backend offline: try again next load */ }
      }
      let { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (!error && !data) {
        // Signed up before the migration's trigger existed.
        const name = (user.user_metadata?.full_name as string | undefined) ?? user.email?.split('@')[0] ?? null;
        ({ data, error } = await supabase
          .from('profiles')
          .upsert({ id: user.id, display_name: name?.slice(0, 40) ?? null })
          .select('*')
          .single());
      }
      if (!alive) return;
      if (error) {
        setProfileError(describeProfileError(error));
      } else {
        setProfile(data as Profile);
        setProfileError(null);
        applyLook((data as Profile).accent, (data as Profile).lumi_outfit);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user, sessionChecked]);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) {
      window.alert('Login is not set up yet: add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to frontend/.env.local, then restart the dev server.');
      return;
    }
    // Supabase sends the user to Google, then back here with ?code=…, which
    // the client exchanges for a session on load.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) console.error('Google sign-in failed:', error.message);
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  const updateProfile = useCallback(async (patch: ProfilePatch) => {
    const current = profileRef.current;
    if (!supabase || !current) return;
    const next = { ...current, ...patch };
    setProfile(next); // optimistic: theme pickers feel instant
    if (patch.accent || patch.lumi_outfit) applyLook(next.accent, next.lumi_outfit);
    const { data, error } = await supabase.from('profiles').update(patch).eq('id', current.id).select('*').single();
    if (error) {
      setProfile(current);
      applyLook(current.accent, current.lumi_outfit);
      throw new Error(error.message);
    }
    setProfile(data as Profile);
  }, []);

  const uploadAvatar = useCallback(async (file: File) => {
    const current = profileRef.current;
    if (!supabase || !current) return;
    const blob = await toAvatarBlob(file);
    // A fresh name each time also busts every cache of the old picture.
    const path = `${current.id}/avatar-${Date.now()}.webp`;
    const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, blob, {
      contentType: 'image/webp',
      cacheControl: '31536000',
    });
    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    const oldPath = ownAvatarPath(current.avatar_url);
    await updateProfile({ avatar_url: data.publicUrl });
    if (oldPath) await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]);
  }, [updateProfile]);

  const setAvatarUrl = useCallback(async (url: string | null) => {
    const current = profileRef.current;
    if (!supabase || !current) return;
    const oldPath = ownAvatarPath(current.avatar_url);
    await updateProfile({ avatar_url: url });
    if (oldPath) await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]);
  }, [updateProfile]);

  const value: AuthState = {
    user, profile, profileError, loading, enabled: !!supabase,
    signInWithGoogle, signOut, updateProfile, uploadAvatar, setAvatarUrl,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

/** Google's profile picture, offered as one avatar option. */
export const googlePhotoUrl = (user: User | null): string | null =>
  ((user?.user_metadata?.avatar_url ?? user?.user_metadata?.picture) as string | undefined) ?? null;
