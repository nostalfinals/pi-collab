export type Delivery<T> = {
  promise: Promise<T>;
  deliver: (value: T) => void;
};

export function createDelivery<T>(): Delivery<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, deliver: resolve };
}
