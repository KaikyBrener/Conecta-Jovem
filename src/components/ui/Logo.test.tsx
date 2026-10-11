import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Logo } from './Logo';

describe('Logo', () => {
  it.each(['claro', 'escuro', 'simbolo', 'icone'] as const)('variante %s: SVG inline com nome acessível', (variant) => {
    const html = renderToStaticMarkup(<Logo variant={variant} />);
    expect(html).toContain('<svg');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="ConectJovem"');
    // sem <img>/URL externa: não depende de img-src na CSP
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/(href|src)="/);
    // sem atributo style nem <style>: a CSP (style-src 'self') bloquearia
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toContain('<style');
    expect(html).toContain(`data-logo="${variant}"`);
  });

  it('as variantes horizontais são arquivos diferentes (claro tem o fundo branco; escuro não)', () => {
    const claro = renderToStaticMarkup(<Logo variant="claro" />);
    const escuro = renderToStaticMarkup(<Logo variant="escuro" />);
    expect(claro).toContain('<rect');
    expect(escuro).not.toContain('<rect');
    expect(claro).toContain('mix-blend-multiply');
    expect(escuro).not.toContain('mix-blend-multiply');
  });

  it('aplica tamanho e className', () => {
    const html = renderToStaticMarkup(<Logo variant="escuro" tamanho="xl" className="logo-tema-escuro" />);
    expect(html).toContain('h-16');
    expect(html).toContain('logo-tema-escuro');
  });
});
