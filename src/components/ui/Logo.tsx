import { cn } from '../../lib/utils';
import logoClaro from '../../assets/logo/logo-horizontal.svg?raw';
import logoEscuro from '../../assets/logo/logo-horizontal-fundo-escuro.svg?raw';
import simbolo from '../../assets/logo/simbolo-cores.svg?raw';
import icone from '../../assets/logo/icone.svg?raw';

/**
 * - `claro`: logo horizontal para fundo claro (o arquivo traz um retângulo branco de fundo).
 * - `escuro`: logo horizontal para fundo azul-marinho (menu, cabeçalho mobile, painel do login).
 * - `simbolo`: só o símbolo, sem fundo (para fundo claro).
 * - `icone`: o símbolo no quadrado com gradiente (o mesmo do favicon); legível em fundo escuro.
 */
type LogoVariant = 'claro' | 'escuro' | 'simbolo' | 'icone';
type LogoSize = 'sm' | 'md' | 'lg' | 'xl';

interface LogoProps {
  variant?: LogoVariant;
  /** Altura do logo; a largura acompanha a proporção do arquivo. */
  tamanho?: LogoSize;
  className?: string;
}

const SVG: Record<LogoVariant, string> = { claro: logoClaro, escuro: logoEscuro, simbolo, icone };

const HEIGHT: Record<LogoSize, string> = { sm: 'h-8', md: 'h-10', lg: 'h-12', xl: 'h-16' };

/**
 * Logotipo do ConectJovem. O SVG entra INLINE, exatamente como está em src/assets/logo (sem <img>, para não
 * depender de img-src na CSP). O nome acessível "ConectJovem" vem do próprio arquivo (role="img" + aria-label).
 */
export function Logo({ variant = 'claro', tamanho = 'md', className }: LogoProps) {
  return (
    <span
      data-logo={variant}
      className={cn(
        'inline-flex flex-shrink-0 [&>svg]:block [&>svg]:h-full [&>svg]:w-auto',
        // o retângulo branco do arquivo "claro" some sobre fundos quase brancos, sem editar o SVG
        variant === 'claro' && 'mix-blend-multiply',
        HEIGHT[tamanho],
        className,
      )}
      dangerouslySetInnerHTML={{ __html: SVG[variant] }}
    />
  );
}
