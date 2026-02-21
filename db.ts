
export class CatalogDB {
  private dbName = 'SiasgCatalogDB';
  private version = 1;

  private async getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('catalogs')) {
          db.createObjectStore('catalogs');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveCatalog(key: string, data: any[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('catalogs', 'readwrite');
      const store = transaction.objectStore('catalogs');
      const request = store.put(data, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getCatalog(key: string): Promise<any[] | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('catalogs', 'readonly');
      const store = transaction.objectStore('catalogs');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction('catalogs', 'readwrite');
    transaction.objectStore('catalogs').clear();
  }
}

export const db = new CatalogDB();
