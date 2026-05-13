
import { Photo, Cluster } from './types';

export const MOCK_PHOTOS: Photo[] = Array.from({ length: 48 }).map((_, i) => ({
  id: `photo-${i}`,
  url: `https://picsum.photos/seed/${i + 100}/800/600`,
  name: `IMG_${1000 + i}.JPG`,
  size: `${(Math.random() * 5 + 1).toFixed(1)} MB`
}));

export const CLUSTERS: Cluster[] = [
  {
    id: 'c1',
    label: 'Golden Hour at Malibu Beach',
    topPhotoId: 'photo-0',
    photos: MOCK_PHOTOS.slice(0, 12)
  },
  {
    id: 'c2',
    label: 'Dinner at Le Restaurant',
    topPhotoId: 'photo-12',
    photos: MOCK_PHOTOS.slice(12, 24)
  },
  {
    id: 'c3',
    label: 'Mountain Hike Adventure',
    topPhotoId: 'photo-24',
    photos: MOCK_PHOTOS.slice(24, 36)
  },
  {
    id: 'c4',
    label: 'City Skyline Night Shots',
    topPhotoId: 'photo-36',
    photos: MOCK_PHOTOS.slice(36, 48)
  }
];
