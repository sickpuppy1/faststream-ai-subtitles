/**
 * IndexedDB cache for transcribed audio chunks, keyed by media and settings.
 * Every method is a no-op (returns null or []) when IndexedDB is missing,
 * and errors are logged, never thrown, so the cache cannot break playback.
 */

const STORE_NAME = 'chunks';
const DB_VERSION = 1;

/**
 * @param {string} mediaKey
 * @param {string} settingsKey
 * @return {string} Value of the 'media' index.
 */
function mediaId(mediaKey, settingsKey) {
  return `${mediaKey}|${settingsKey}`;
}

/**
 * @param {string} mediaKey
 * @param {string} settingsKey
 * @param {number} start Chunk start in seconds.
 * @return {string} Primary key of the record.
 */
function chunkId(mediaKey, settingsKey, start) {
  return `${mediaId(mediaKey, settingsKey)}|${start.toFixed(2)}`;
}

/**
 * Resolves with the result of an IDBRequest.
 * @param {IDBRequest} request
 * @return {Promise<unknown>}
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Resolves when an IDBTransaction commits, rejects if it aborts.
 * @param {IDBTransaction} tx
 * @return {Promise<void>}
 */
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Stores transcribed chunks in IndexedDB. */
export class TranscriptCache {
  #dbName;
  #dbPromise = null;

  /**
   * @param {string} [dbName] IndexedDB database name.
   */
  constructor(dbName = 'fs-ai-subtitles') {
    this.#dbName = dbName;
  }

  /**
   * Opens the database once and caches the promise.
   * @return {Promise<IDBDatabase>}
   */
  #open() {
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(this.#dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE_NAME, {keyPath: 'id'});
          store.createIndex('media', 'media', {unique: false});
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.#dbPromise;
  }

  /**
   * Runs a task against the database, returning fallback on any failure.
   * @param {unknown} fallback
   * @param {(db: IDBDatabase) => Promise<unknown>} task
   * @return {Promise<unknown>}
   */
  async #run(fallback, task) {
    if (!globalThis.indexedDB) {
      return fallback;
    }
    try {
      return await task(await this.#open());
    } catch (error) {
      console.warn('TranscriptCache: operation failed, continuing without cache.', error);
      return fallback;
    }
  }

  /**
   * Returns cached chunks for one media item and settings set, sorted by start.
   * @param {string} mediaKey
   * @param {string} settingsKey
   * @return {Promise<Array<{start: number, end: number, cues: unknown, text: string, language: string, savedAt: number}>>}
   */
  async getChunks(mediaKey, settingsKey) {
    return this.#run([], async (db) => {
      const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
      const records = await requestToPromise(
          store.index('media').getAll(mediaId(mediaKey, settingsKey)),
      );
      return records
          .map(({start, end, cues, text, language, savedAt}) => ({
            start, end, cues, text, language, savedAt,
          }))
          .sort((a, b) => a.start - b.start);
    });
  }

  /**
   * Stores one chunk, replacing any chunk with the same start time.
   * @param {string} mediaKey
   * @param {string} settingsKey
   * @param {{start: number, end: number, cues: unknown, text: string, language: string, savedAt?: number}} chunk
   * @return {Promise<void>}
   */
  async putChunk(mediaKey, settingsKey, chunk) {
    return this.#run(undefined, async (db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        id: chunkId(mediaKey, settingsKey, chunk.start),
        media: mediaId(mediaKey, settingsKey),
        start: chunk.start,
        end: chunk.end,
        cues: chunk.cues,
        text: chunk.text,
        language: chunk.language,
        savedAt: chunk.savedAt ?? Date.now(),
      });
      await transactionDone(tx);
    });
  }

  /**
   * Deletes the oldest records (by savedAt) when there are more than maxEntries.
   * @param {number} [maxEntries] Maximum records to keep.
   * @return {Promise<number|null>} Number of deleted records, or null if unavailable.
   */
  async prune(maxEntries = 20000) {
    return this.#run(null, async (db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const entries = [];
      let removed = 0;
      await new Promise((resolve, reject) => {
        const request = store.openCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            entries.push({id: cursor.primaryKey, savedAt: cursor.value.savedAt ?? 0});
            cursor.continue();
            return;
          }
          // Deletes run inside the cursor callback, while the transaction is still open.
          removed = Math.max(entries.length - maxEntries, 0);
          if (removed > 0) {
            entries.sort((a, b) => a.savedAt - b.savedAt);
            for (const entry of entries.slice(0, removed)) {
              store.delete(entry.id);
            }
          }
          resolve();
        };
      });
      await transactionDone(tx);
      return removed;
    });
  }
}
