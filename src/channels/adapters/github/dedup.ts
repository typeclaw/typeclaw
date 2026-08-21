export type DeliveryDedup = {
  has: (deliveryId: string) => boolean
  add: (deliveryId: string) => void
  size: () => number
}

export type BoundedMap<K, V> = {
  has: (key: K) => boolean
  get: (key: K) => V | undefined
  set: (key: K, value: V) => void
  delete: (key: K) => boolean
  size: () => number
}

export function createBoundedMap<K, V>(limit = 1000): BoundedMap<K, V> {
  const values = new Map<K, V>()
  return {
    has(key): boolean {
      return values.has(key)
    },
    get(key): V | undefined {
      return values.get(key)
    },
    set(key, value): void {
      if (values.has(key)) values.delete(key)
      values.set(key, value)
      while (values.size > limit) {
        const oldest = values.keys().next().value
        if (oldest === undefined) break
        values.delete(oldest)
      }
    },
    delete(key): boolean {
      return values.delete(key)
    },
    size(): number {
      return values.size
    },
  }
}

export function createDeliveryDedup(limit = 1000): DeliveryDedup {
  const seen = createBoundedMap<string, true>(limit)
  return {
    has(deliveryId: string): boolean {
      return seen.has(deliveryId)
    },
    add(deliveryId: string): void {
      seen.set(deliveryId, true)
    },
    size(): number {
      return seen.size()
    },
  }
}
