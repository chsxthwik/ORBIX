// Copy the methods of helper classes onto a class, so one large class can be written as several focused files that
// share its state (`this`). The helpers are never instantiated; a name defined twice is an error, not an override.
export function mixin(target, ...parts) {
  for (const part of parts) {
    for (const name of Object.getOwnPropertyNames(part.prototype)) {
      if (name === 'constructor') continue;
      if (Object.prototype.hasOwnProperty.call(target.prototype, name)) throw new Error(`${target.name}.${name} is defined twice (in ${part.name} too)`);
      Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
    }
  }
  return target;
}
