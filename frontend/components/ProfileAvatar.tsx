import React from 'react';
import { lumiSrc, type LumiPose } from './Lumi';
import { avatarBgCss, type Profile } from '../lib/profile';

interface ProfileAvatarProps {
  profile: Pick<Profile, 'avatar_pose' | 'avatar_bg' | 'avatar_url' | 'display_name'> | null;
  size?: number;
  className?: string;
}

/** The user's badge: their uploaded photo, or Lumi in their chosen pose on
 *  their chosen colour. Lumi wears the user's outfit via .lumi-sprite. */
export const ProfileAvatar: React.FC<ProfileAvatarProps> = ({ profile, size = 40, className = '' }) => {
  const style: React.CSSProperties = { width: size, height: size };
  if (profile?.avatar_url) {
    return (
      <span className={`block rounded-full overflow-hidden bg-white ${className}`} style={style}>
        <img
          src={profile.avatar_url}
          alt=""
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
          draggable={false}
        />
      </span>
    );
  }
  return (
    <span
      className={`relative block rounded-full overflow-hidden ${className}`}
      style={{ ...style, background: avatarBgCss(profile?.avatar_bg) }}
    >
      {/* Sprites are full-body; scale up and anchor to the top for a head-and-shoulders crop. */}
      <img
        src={lumiSrc((profile?.avatar_pose ?? 'wave') as LumiPose)}
        alt=""
        aria-hidden
        draggable={false}
        className="lumi-sprite absolute left-1/2 top-[6%] h-[150%] w-auto max-w-none -translate-x-1/2"
      />
    </span>
  );
};
