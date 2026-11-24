export type Element = { id: string; type: string; [key: string]: unknown }
export function parse(text: string): { elements: Element[]; problems: string[]; own: boolean }
export function serialize(elements: Element[], mark?: boolean): string
