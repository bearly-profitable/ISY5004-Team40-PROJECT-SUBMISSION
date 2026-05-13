import type { Photo } from '../types';

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

type PickerFolder = {
  id: string;
  name: string;
};

type GoogleDriveFile = {
  id: string;
  /** The file ID to use when downloading — equals `id` for real files, equals the shortcut target for shortcuts. */
  downloadId: string;
  name: string;
  mimeType: string;
  size?: string;
};

type RawDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  shortcutDetails?: {
    targetId: string;
    targetMimeType: string;
  };
};

const GAPI_SRC = 'https://apis.google.com/js/api.js';
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const IMAGE_MIME_PREFIX = 'image/';
const MAX_PREVIEW_IMAGES = 80;

let scriptsReadyPromise: Promise<void> | null = null;

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;
const GOOGLE_PROJECT_NUMBER = import.meta.env.VITE_GOOGLE_PROJECT_NUMBER as string | undefined;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`Failed to load script: ${src}`)));
    document.head.appendChild(script);
  });
}

async function ensureGoogleApisLoaded(): Promise<void> {
  if (!scriptsReadyPromise) {
    scriptsReadyPromise = (async () => {
      await Promise.all([loadScript(GAPI_SRC), loadScript(GSI_SRC)]);

      if (!window.gapi) {
        throw new Error('Google API script failed to initialize.');
      }

      await new Promise<void>((resolve, reject) => {
        window.gapi.load('picker', {
          callback: () => resolve(),
          onerror: () => reject(new Error('Failed to initialize Google Picker.')),
          timeout: 10_000,
          ontimeout: () => reject(new Error('Google Picker initialization timed out.')),
        });
      });
    })();
  }

  await scriptsReadyPromise;
}

function requireEnvConfig(): void {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('Missing VITE_GOOGLE_CLIENT_ID in frontend/.env.local');
  }
  if (!GOOGLE_API_KEY) {
    throw new Error('Missing VITE_GOOGLE_API_KEY in frontend/.env.local');
  }
}

function requestAccessToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google Identity Services failed to initialize.'));
      return;
    }

    let settled = false;
    const tokenClient: GoogleTokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response: { access_token?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        if (!response.access_token) {
          reject(new Error('No access token returned by Google.'));
          return;
        }
        resolve(response.access_token);
      },
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

function pickFolder(accessToken: string, apiKey: string, appId?: string): Promise<PickerFolder> {
  return new Promise((resolve, reject) => {
    if (!window.google?.picker) {
      reject(new Error('Google Picker is not available.'));
      return;
    }

    const folderView = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setParent('root'); // Restrict to My Drive — hides Computers, Shared drives, etc.

    const callback = (data: { action: string; docs?: Array<{ id: string; name: string }> }) => {
      if (data.action === window.google.picker.Action.PICKED && data.docs?.[0]) {
        resolve({ id: data.docs[0].id, name: data.docs[0].name });
        return;
      }
      if (data.action === window.google.picker.Action.CANCEL) {
        reject(new Error('Folder selection was cancelled.'));
      }
    };

    let pickerBuilder = new window.google.picker.PickerBuilder()
      .setDeveloperKey(apiKey)
      .setOAuthToken(accessToken)
      .setTitle('Select a Google Drive folder')
      .addView(folderView)
      .setCallback(callback);

    if (appId) {
      pickerBuilder = pickerBuilder.setAppId(appId);
    }

    const picker = pickerBuilder.build();
    picker.setVisible(true);
  });
}

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

async function listFolderImages(accessToken: string, folderId: string): Promise<GoogleDriveFile[]> {
  const raw: RawDriveFile[] = [];
  let pageToken: string | undefined;

  do {
    // Fetch real image files AND shortcuts (which may point to images stored elsewhere, e.g. via Google Photos)
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and (mimeType contains '${IMAGE_MIME_PREFIX}' or mimeType = '${SHORTCUT_MIME}')`,
      fields: 'nextPageToken,files(id,name,mimeType,size,shortcutDetails)',
      pageSize: '1000',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to read folder contents (${response.status}).`);
    }

    const payload = await response.json() as { files?: RawDriveFile[]; nextPageToken?: string };
    raw.push(...(payload.files ?? []));
    pageToken = payload.nextPageToken;
  } while (pageToken);

  // Resolve shortcuts: if a shortcut points to an image, keep it but use the target ID for downloading
  const resolved: GoogleDriveFile[] = [];
  for (const f of raw) {
    if (f.mimeType.startsWith(IMAGE_MIME_PREFIX)) {
      resolved.push({ id: f.id, downloadId: f.id, name: f.name, mimeType: f.mimeType, size: f.size });
    } else if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetMimeType.startsWith(IMAGE_MIME_PREFIX)) {
      resolved.push({
        id: f.id,
        downloadId: f.shortcutDetails.targetId,
        name: f.name,
        mimeType: f.shortcutDetails.targetMimeType,
        size: f.size,
      });
    }
  }
  return resolved;
}

function bytesToLabel(size?: string): string {
  if (!size) return 'Unknown size';
  const parsed = Number(size);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'Unknown size';
  const mb = parsed / (1024 * 1024);
  if (mb < 1) {
    const kb = parsed / 1024;
    return `${kb.toFixed(1)} KB`;
  }
  return `${mb.toFixed(1)} MB`;
}

async function loadImageObjectUrl(accessToken: string, fileId: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Could not download image ${fileId}.`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export async function connectGoogleDriveAndLoadPhotos(): Promise<{
  folderName: string;
  folderId: string;
  photos: Photo[];
}> {
  requireEnvConfig();
  await ensureGoogleApisLoaded();

  const accessToken = await requestAccessToken(GOOGLE_CLIENT_ID as string);
  const folder = await pickFolder(accessToken, GOOGLE_API_KEY as string, GOOGLE_PROJECT_NUMBER);
  const driveFiles = await listFolderImages(accessToken, folder.id);

  if (driveFiles.length === 0) {
    throw new Error(
      `No images found directly in "${folder.name}". Make sure your images are placed directly inside this folder (not in subfolders), then try again.`
    );
  }

  const imageFiles = driveFiles.slice(0, MAX_PREVIEW_IMAGES);
  const photos = await Promise.all(
    imageFiles.map(async (file) => {
      const objectUrl = await loadImageObjectUrl(accessToken, file.downloadId);
      return {
        id: file.id,
        name: file.name,
        size: bytesToLabel(file.size),
        url: objectUrl,
      };
    }),
  );

  return {
    folderName: folder.name,
    folderId: folder.id,
    photos,
  };
}
