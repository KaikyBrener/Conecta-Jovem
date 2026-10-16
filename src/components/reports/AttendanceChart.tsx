import { useId } from 'react';
import { formatDay } from '../../lib/format';
import type { AttendanceSeriesPoint } from '../../lib/reportTypes';

/* Área do gráfico: altura fixa (o texto não escala com a largura); as barras usam % da largura */
const PLOT_H = 160;
const TICKS = [100, 50, 0];

const shortDay = (date: string) => formatDay(date).slice(0, 5);

/**
 * Gráfico simples de barras (SVG inline) da frequência por dia com chamada. Eixo de 0 a 100% com linhas de
 * grade em 0, 50 e 100; barras em um só tom (azul institucional). Acessível: o SVG tem título e descrição em
 * texto e os valores exatos ficam numa tabela logo abaixo ("Ver valores"). Não é uma classificação: as barras
 * seguem a ordem das datas.
 */
export function AttendanceChart({ points, title }: { points: AttendanceSeriesPoint[]; title: string }) {
  const uid = useId();
  if (points.length === 0) return null;

  const slot = 100 / points.length;
  const barW = Math.min(slot * 0.6, 4.5);
  const y = (rate: number) => PLOT_H * (1 - Math.min(100, Math.max(0, rate)) / 100);

  const rates = points.map((p) => p.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const desc =
    `${points.length} ${points.length === 1 ? 'dia' : 'dias'} com chamada, de ${shortDay(points[0].date)} a ` +
    `${shortDay(points[points.length - 1].date)}. Frequência entre ${min}% e ${max}%.`;

  const labelIdx = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];

  return (
    <div data-testid="grafico-frequencia">
      <div className="flex gap-2">
        {/* rótulos do eixo (os valores exatos estão na descrição e na tabela) */}
        <div className="relative w-9 flex-shrink-0 text-right text-xs leading-none text-ink-muted" aria-hidden="true">
          {TICKS.map((v) => (
            <span key={v} className={v === 100 ? 'absolute right-0 top-0 -translate-y-1/2' : v === 50 ? 'absolute right-0 top-1/2 -translate-y-1/2' : 'absolute bottom-0 right-0 translate-y-1/2'}>
              {v}%
            </span>
          ))}
        </div>
        <svg role="img" aria-labelledby={`${uid}-t ${uid}-d`} width="100%" height={PLOT_H} className="block min-w-0 flex-1 overflow-visible">
          <title id={`${uid}-t`}>{title}</title>
          <desc id={`${uid}-d`}>{desc}</desc>
          {TICKS.map((v) => (
            <line key={v} x1="0" x2="100%" y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} />
          ))}
          <g fill="var(--color-action)">
            {points.map((p, i) => {
              const top = y(p.rate);
              return (
                <rect key={p.date} x={`${slot * i + (slot - barW) / 2}%`} y={top} width={`${barW}%`} height={Math.max(1, PLOT_H - top)} rx={2}>
                  <title>{`${formatDay(p.date)}: ${p.rate}% (${p.present} de ${p.registered})`}</title>
                </rect>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="ml-11 mt-2.5 flex justify-between text-xs leading-none text-ink-muted" aria-hidden="true">
        {labelIdx.map((i) => <span key={points[i].date}>{shortDay(points[i].date)}</span>)}
      </div>
      <p className="ml-11 mt-2 text-center text-xs text-ink-muted">Dias com chamada, do mais antigo ao mais recente</p>

      <details className="mt-3 text-sm">
        <summary className="inline-block cursor-pointer rounded-tag text-label font-medium text-action hover:underline">Ver valores</summary>
        <div className="mt-2 max-h-56 overflow-y-auto rounded-control border border-line">
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">Data</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Presentes</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Registros</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Frequência</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {points.map((p) => (
                <tr key={p.date}>
                  <td className="px-3 py-1.5 text-gray-900">{formatDay(p.date)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{p.present}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{p.registered}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-900">{p.rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
