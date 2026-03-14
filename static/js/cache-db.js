/**
 * IndexedDB 封装层 - 离线缓存
 * 数据库名: codereader-cache, 版本: 1
 */
const CacheDB = {
    /** @type {IDBDatabase|null} */
    _db: null,

    /** 打开/创建数据库 @returns {Promise<IDBDatabase>} */
    open() {
        if (this._db) return Promise.resolve(this._db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('codereader-cache', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;

                db.createObjectStore('projects', { keyPath: 'id' });

                const functions = db.createObjectStore('functions', { keyPath: 'id' });
                functions.createIndex('projectId', 'projectId', { unique: false });

                const functionDetails = db.createObjectStore('functionDetails', { keyPath: 'id' });
                functionDetails.createIndex('projectId', 'projectId', { unique: false });

                const aiExplanations = db.createObjectStore('aiExplanations', { keyPath: 'functionId' });
                aiExplanations.createIndex('projectId', 'projectId', { unique: false });

                db.createObjectStore('callGraphs', { keyPath: 'projectId' });

                const readingPaths = db.createObjectStore('readingPaths', { keyPath: 'id' });
                readingPaths.createIndex('projectId', 'projectId', { unique: false });

                const chatHistories = db.createObjectStore('chatHistories', { keyPath: 'functionId' });
                chatHistories.createIndex('projectId', 'projectId', { unique: false });

                db.createObjectStore('progress', { keyPath: 'projectId' });

                const offlineOps = db.createObjectStore('offlineOps', { keyPath: 'id', autoIncrement: true });
                offlineOps.createIndex('timestamp', 'timestamp', { unique: false });
                offlineOps.createIndex('projectId', 'projectId', { unique: false });

                db.createObjectStore('cacheMeta', { keyPath: 'projectId' });
            };
            req.onsuccess = (e) => {
                this._db = e.target.result;
                resolve(this._db);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    },

    // ========== 通用 CRUD ==========

    /** @returns {Promise<*>} */
    get(storeName, key) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    },

    /** @returns {Promise<Array>} */
    getAll(storeName) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    },

    /** @returns {Promise<Array>} */
    getAllByIndex(storeName, indexName, value) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const store = db.transaction(storeName, 'readonly').objectStore(storeName);
            const req = store.index(indexName).getAll(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    },

    /** @returns {Promise<*>} 返回key */
    put(storeName, data) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(data);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    },

    /** @returns {Promise<void>} */
    putMany(storeName, dataArray) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            for (const item of dataArray) {
                store.put(item);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    },

    /** @returns {Promise<void>} */
    delete(storeName, key) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },

    /** @returns {Promise<void>} */
    deleteByIndex(storeName, indexName, value) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const req = store.index(indexName).openCursor(value);
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    },

    /** @returns {Promise<void>} */
    clear(storeName) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readwrite').objectStore(storeName).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },

    // ========== offlineOps 队列专用 ==========

    /** 入队操作 @param {Object} op @returns {Promise<number>} 返回自增id */
    enqueueOp(op) {
        return this.put('offlineOps', op);
    },

    /** 取前N条pending操作 @param {number} [count] @returns {Promise<Array>} */
    dequeueOps(count) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const store = db.transaction('offlineOps', 'readonly').objectStore('offlineOps');
            const results = [];
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) { resolve(results); return; }
                if (cursor.value.status === 'pending') {
                    results.push(cursor.value);
                    if (count && results.length >= count) { resolve(results); return; }
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        }));
    },

    /** @returns {Promise<Array>} */
    getAllPendingOps() {
        return this.dequeueOps();
    },

    /** @param {number} id @param {string} status @returns {Promise<void>} */
    updateOpStatus(id, status) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction('offlineOps', 'readwrite');
            const store = tx.objectStore('offlineOps');
            const req = store.get(id);
            req.onsuccess = () => {
                const op = req.result;
                if (op) {
                    op.status = status;
                    store.put(op);
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    },

    /** @param {number} id @returns {Promise<void>} */
    removeOp(id) {
        return this.delete('offlineOps', id);
    },

    /** 清理已完成的操作 @returns {Promise<void>} */
    clearCompletedOps() {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction('offlineOps', 'readwrite');
            const store = tx.objectStore('offlineOps');
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) return;
                if (cursor.value.status !== 'pending' && cursor.value.status !== 'syncing') {
                    cursor.delete();
                }
                cursor.continue();
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    },

    // ========== cacheMeta 专用 ==========

    /** @param {number} projectId @returns {Promise<Object|undefined>} */
    getCacheMeta(projectId) {
        return this.get('cacheMeta', projectId);
    },

    /** @param {number} projectId @param {Object} meta @returns {Promise<void>} */
    setCacheMeta(projectId, meta) {
        return this.put('cacheMeta', { ...meta, projectId });
    },

    /** @param {number} projectId @returns {Promise<void>} */
    deleteCacheMeta(projectId) {
        return this.delete('cacheMeta', projectId);
    },

    // ========== 项目缓存清理 ==========

    /** 删除某项目的所有缓存数据 @param {number} projectId @returns {Promise<void>} */
    deleteProjectCache(projectId) {
        const indexedStores = ['functions', 'functionDetails', 'aiExplanations', 'readingPaths', 'chatHistories', 'offlineOps'];
        const keyPathStores = ['callGraphs', 'progress', 'cacheMeta'];
        return Promise.all([
            ...indexedStores.map(s => this.deleteByIndex(s, 'projectId', projectId)),
            ...keyPathStores.map(s => this.delete(s, projectId)),
            this.delete('projects', projectId),
        ]);
    },
};
