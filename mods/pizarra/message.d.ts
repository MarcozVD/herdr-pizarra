import type { Element } from './model.js'
export function compose(about: {
  ask: boolean; said: string; all: Element[]; part: Element[] | null; seen: Element[] | null
  dir: string; cli: string; png: string | null; width: number; height: number
}): { wish: string; text: string }
