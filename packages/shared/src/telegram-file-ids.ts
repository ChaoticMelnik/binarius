// The file_id cache of a picture or an animation a process sends again and again (#859, Rule 58):
// uploaded until an answer brings its file_id, then sent by it. Memory only, so a restart or a
// second process uploads again; a refused file forgets its id, so the next send uploads the file.
// Typed by the answer's shape, so this package needs no grammY: a grammY Message is one.
export interface TelegramFileAnswer {
  animation?: { file_id: string };
  // the largest size is last; any size names the same photo to Telegram
  photo?: readonly { file_id: string }[];
}

export interface TelegramFileIds<K> {
  get: (key: K) => string | undefined;
  // reads the id from a sendAnimation's, a sendPhoto's or an editMessageMedia's answer; an inline
  // edit's `true` carries none and is ignored. False when a message came without an id
  remember: (key: K, result: TelegramFileAnswer | true) => boolean;
  forget: (key: K) => void;
}

// `maxEntries` bounds the memory of a cache keyed by an unbounded set (#875, the promo cards by
// session): a read makes its key the newest, and a remember past the bound drops the oldest.
export function createTelegramFileIds<K>(options?: { maxEntries?: number }): TelegramFileIds<K> {
  const ids = new Map<K, string>();
  const maxEntries = options?.maxEntries;
  return {
    get: (key) => {
      const fileId = ids.get(key);
      if (fileId !== undefined && maxEntries !== undefined) {
        ids.delete(key);
        ids.set(key, fileId);
      }
      return fileId;
    },
    remember: (key, result) => {
      if (result === true || ids.has(key)) return true;
      const fileId = result.animation?.file_id ?? result.photo?.at(-1)?.file_id;
      if (fileId === undefined) return false;
      ids.set(key, fileId);
      if (maxEntries !== undefined && ids.size > maxEntries) {
        const oldest = ids.keys().next();
        if (oldest.done !== true) ids.delete(oldest.value);
      }
      return true;
    },
    forget: (key) => {
      ids.delete(key);
    },
  };
}
