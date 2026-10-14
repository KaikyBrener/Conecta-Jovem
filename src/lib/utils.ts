import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Ensina ao tailwind-merge os tokens de index.css: sem isto, `text-heading` (tamanho) seria tratado como cor
// e descartado ao lado de `text-ink`, e `rounded-card` não substituiria um `rounded-control` anterior.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['display', 'title', 'dialog', 'heading', 'body', 'table', 'label', 'caption', 'micro', 'stat'],
      radius: ['tag', 'control', 'card', 'sheet'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
