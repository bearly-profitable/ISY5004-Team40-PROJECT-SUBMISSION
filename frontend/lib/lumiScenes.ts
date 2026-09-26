import type { LumiPose } from '../components/Lumi';

/** CLIP event labels to Lumi's outfit for them. Mirrors backend/mascot.py
 *  SCENE_POSES, so an event looks the same in the gallery and the album. */
const SCENE_POSES: Record<string, LumiPose> = {
  Wedding: 'wedding',
  Birthday: 'birthday',
  Party: 'celebrate',
  Graduation: 'graduation',
  Christmas: 'christmas',
  Cafe: 'cafe',
  Breakfast: 'cafe',
  Dinner: 'dinner',
  'Hawker Meal': 'dinner',
  Picnic: 'garden',
  Beach: 'beach',
  Pool: 'beach',
  Hiking: 'hiking',
  Camping: 'hiking',
  Travel: 'travel',
  Street: 'travel',
  Museum: 'travel',
  Garden: 'garden',
  'At Home': 'home',
  'Family Gathering': 'hug',
  Shopping: 'shopping',
  Meeting: 'meeting',
  'Night Out': 'night',
  Concert: 'night',
  Sports: 'celebrate',
  'Selfie Session': 'camera',
};

const WORK_POSES: LumiPose[] = ['carry', 'hang', 'point', 'camera', 'star', 'sort'];

/** Lumi's pose for an event: its scene if the label names one (loosely, so a
 *  renamed "Beach day at Sentosa" still counts), otherwise a work pose. */
export function poseForEvent(labels: (string | null | undefined)[], index: number): LumiPose {
  for (const label of labels) {
    if (!label) continue;
    if (SCENE_POSES[label]) return SCENE_POSES[label];
    const lowered = label.toLowerCase();
    const hit = Object.keys(SCENE_POSES).find((scene) => lowered.includes(scene.toLowerCase()));
    if (hit) return SCENE_POSES[hit];
  }
  return WORK_POSES[index % WORK_POSES.length];
}
