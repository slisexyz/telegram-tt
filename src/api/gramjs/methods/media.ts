import { Api as GramJs } from '../../../lib/gramjs';

import type { TelegramClient } from '../../../lib/gramjs';
import type { ApiOnProgress, ApiParsedMedia } from '../../types';
import {
  ApiMediaFormat,
} from '../../types';

import {
  DOWNLOAD_WORKERS,
  MEDIA_CACHE_DISABLED,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_NAME,
  MEDIA_CACHE_NAME_AVATARS,
} from '../../../config';
import * as cacheApi from '../../../util/cacheApi';
import { getEntityTypeById } from '../gramjsBuilders';
import localDb from '../localDb';

const MEDIA_ENTITY_TYPES: Set<EntityType> = new Set([
  'sticker', 'wallpaper', 'photo', 'webDocument', 'document',
]);

const JPEG_SIZE_TYPES = new Set(['s', 'm', 'x', 'y', 'w', 'a', 'b', 'c', 'd']);
const MP4_SIZES_TYPES = new Set(['u', 'v']);

export default async function downloadMedia(
  {
    url, mediaFormat, start, end, isHtmlAllowed,
  }: {
    url: string; mediaFormat: ApiMediaFormat; start?: number; end?: number; isHtmlAllowed?: boolean;
  },
  client: TelegramClient,
  onProgress?: ApiOnProgress,
) {
  const {
    data, mimeType, fullSize,
  } = await download(url, client, onProgress, start, end, isHtmlAllowed) || {};

  if (!data) {
    return undefined;
  }

  const parsed = await parseMedia(data, mediaFormat, mimeType);
  if (!parsed) {
    return undefined;
  }

  const canCache = mediaFormat !== ApiMediaFormat.Progressive && (
    mediaFormat !== ApiMediaFormat.BlobUrl || (parsed as Blob).size <= MEDIA_CACHE_MAX_BYTES
  );

  if (!MEDIA_CACHE_DISABLED && cacheApi && canCache) {
    const cacheName = url.startsWith('avatar') ? MEDIA_CACHE_NAME_AVATARS : MEDIA_CACHE_NAME;
    void cacheApi.save(cacheName, url, parsed);
  }

  const dataBlob = mediaFormat === ApiMediaFormat.Progressive ? '' : parsed as string | Blob;
  const arrayBuffer = mediaFormat === ApiMediaFormat.Progressive ? parsed as ArrayBuffer : undefined;

  return {
    dataBlob,
    arrayBuffer,
    mimeType,
    fullSize,
  };
}

export type EntityType = (
  'sticker' | 'wallpaper' | 'channel' | 'chat' | 'user' | 'photo' | 'stickerSet' | 'webDocument' |
  'document' | 'staticMap'
);

async function download(
  url: string,
  client: TelegramClient,
  onProgress?: ApiOnProgress,
  start?: number,
  end?: number,
  isHtmlAllowed?: boolean,
) {
  const parsed = parseMediaUrl(url);

  if (!parsed) return undefined;

  const {
    entityType, entityId, sizeType, params, mediaMatchType,
  } = parsed;

  if (entityType === 'staticMap') {
    const accessHash = entityId;
    const parsedParams = new URLSearchParams(params);
    const long = parsedParams.get('long');
    const lat = parsedParams.get('lat');
    const w = parsedParams.get('w');
    const h = parsedParams.get('h');
    const zoom = parsedParams.get('zoom');
    const scale = parsedParams.get('scale');
    const accuracyRadius = parsedParams.get('accuracy_radius');

    const data = await client.downloadStaticMap(accessHash, long, lat, w, h, zoom, scale, accuracyRadius);
    return {
      mimeType: 'image/png',
      data,
    };
  }

  let entity: (
    GramJs.User | GramJs.Chat | GramJs.Channel | GramJs.Photo |
    GramJs.Message | GramJs.MessageService |
    GramJs.Document | GramJs.StickerSet | GramJs.TypeWebDocument | undefined
  );

  switch (entityType) {
    case 'channel':
    case 'chat':
      entity = localDb.chats[entityId];
      break;
    case 'user':
      entity = localDb.users[entityId];
      break;
    case 'sticker':
    case 'wallpaper':
    case 'document':
      entity = localDb.documents[entityId];
      break;
    case 'photo':
      entity = localDb.photos[entityId];
      break;
    case 'stickerSet':
      entity = localDb.stickerSets[entityId];
      break;
    case 'webDocument':
      entity = localDb.webDocuments[entityId];
      break;
  }

  if (!entity) {
    return undefined;
  }

  if (MEDIA_ENTITY_TYPES.has(entityType)) {
    const data = await client.downloadMedia(entity, {
      sizeType, start, end, progressCallback: onProgress, workers: DOWNLOAD_WORKERS,
    });
    let mimeType;
    let fullSize;

    if (sizeType && JPEG_SIZE_TYPES.has(sizeType)) {
      mimeType = 'image/jpeg';
    } else if (sizeType && MP4_SIZES_TYPES.has(sizeType)) {
      mimeType = 'video/mp4';
    } else if (entity instanceof GramJs.Photo) {
      mimeType = 'image/jpeg';
    } else if (entity instanceof GramJs.WebDocument) {
      mimeType = entity.mimeType;
      fullSize = entity.size;
    } else if (entity instanceof GramJs.Document) {
      mimeType = entity.mimeType;
      fullSize = entity.size.toJSNumber();
    }

    // Prevent HTML-in-video attacks
    if (!isHtmlAllowed && mimeType) {
      mimeType = mimeType.replace(/html/gi, '');
    }

    return { mimeType, data, fullSize };
  } else if (entityType === 'stickerSet') {
    const data = await client.downloadStickerSetThumb(entity);
    const mimeType = getMimeType(data);

    return { mimeType, data };
  } else {
    const data = await client.downloadProfilePhoto(entity, mediaMatchType === 'profile');
    const mimeType = getMimeType(data);

    return { mimeType, data };
  }
}

// eslint-disable-next-line no-async-without-await/no-async-without-await
async function parseMedia(
  data: Buffer, mediaFormat: ApiMediaFormat, mimeType?: string,
): Promise<ApiParsedMedia | undefined> {
  switch (mediaFormat) {
    case ApiMediaFormat.BlobUrl:
      return new Blob([data], { type: mimeType });
    case ApiMediaFormat.Text:
      return data.toString();
    case ApiMediaFormat.Progressive:
    case ApiMediaFormat.DownloadUrl:
      return data.buffer;
  }

  return undefined;
}

function getMimeType(data: Uint8Array, fallbackMimeType = 'image/jpeg') {
  if (!data || data.length < 4) {
    return fallbackMimeType;
  }

  let type = fallbackMimeType;
  const signature = data.subarray(0, 4).reduce((result, byte) => result + byte.toString(16), '');

  // https://en.wikipedia.org/wiki/List_of_file_signatures
  switch (signature) {
    case '89504e47':
      type = 'image/png';
      break;
    case '47494638':
      type = 'image/gif';
      break;
    case 'ffd8ffe0':
    case 'ffd8ffe1':
    case 'ffd8ffe2':
    case 'ffd8ffe3':
    case 'ffd8ffe8':
      type = 'image/jpeg';
      break;
    case '52494646':
      // In our case only webp is expected
      type = 'image/webp';
      break;
  }

  return type;
}

export function parseMediaUrl(url: string) {
  const mediaMatch = url.startsWith('staticMap')
    ? url.match(/(staticMap):([0-9-]+)(\?.+)/)
    : url.startsWith('webDocument')
      ? url.match(/(webDocument):(.+)/)
      : url.match(
        // eslint-disable-next-line max-len
        /(avatar|profile|photo|stickerSet|sticker|wallpaper|document)([-\d\w./]+)(?::\d+)?(\?size=\w+)?/,
      );
  if (!mediaMatch) {
    return undefined;
  }

  const mediaMatchType = mediaMatch[1];
  const entityId: string | number = mediaMatch[2];

  let entityType: EntityType;
  const params = mediaMatch[3];
  const sizeType = params?.replace('?size=', '') || undefined;

  if (mediaMatch[1] === 'avatar' || mediaMatch[1] === 'profile') {
    entityType = getEntityTypeById(entityId);
  } else {
    entityType = mediaMatch[1] as EntityType;
  }

  return {
    mediaMatchType,
    entityType,
    entityId,
    sizeType,
    params,
  };
}
