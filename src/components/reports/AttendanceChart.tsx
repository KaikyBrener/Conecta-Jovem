import { useId } from 'react';
import { formatDay } from '../../lib/format';
import type { AttendanceSeriesPoint } from '../../lib/reportTypes';

const W = 600;
const H = 180;
const PAD = { left: 34, right: 8, top: 10, bottom: 26 };

const shortDay = (date: string) => formatDay(date).slice(0, 5);

/**
 * Gráfico simples de barras (SVG inline) da frequência por dia com chamada. Acessível: o SVG tem título e
 * descrição em texto e os valores exatos ficam numa tabela logo abaixo ("Ver valores"). Uma só cor; tema escuro
 * pelas classes já remapeadas (currentColor). Não é uma classificação: as barras seguem a ordem das datas.
 */
export function AttendanceChart({ points, title }: { points: AttendanceSeriesPoint[]; title: string }) {
  const uid = useId();
  if (points.length === 0) return null;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / points.length;
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const y = (rate: number) => PAD.top + plotH * (1 - Math.min(100, Math.max(0, rate)) / 100);

  const rates = points.map((p) => p.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const desc =
    `${points.length} ${points.length === 1 ? 'dia' : 'dias'} com chamada, de ${shortDay(points[0].date)} a ` +
    `${shortDay(points[points.length - 1].date)}. Frequência entre ${min}% e ${max}%.`;

  const labelIdx = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];

  return (
    <div data-testid="grafico-frequencia">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${uid}-t ${uid}-d`} className="h-auto w-full">
        <title id={`${uid}-t`}>{title}</title>
        <desc id={`${uid}-d`}>{desc}</desc>
        {[0, 50, 100].map((v) => (
          <g key={v} className="text-gray-400">
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={0.35} strokeDasharray={v === 0 ? undefined : '3 3'} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="currentColor">{v}%</text>
          </g>
        ))}
        <g className="text-blue-700" fill="currentColor">
          {points.map((p, i) => {
            const x = PAD.left + slot * i + (slot - barW) / 2;
            const top = y(p.rate);
            return (
              <rect key={p.date} x={x} y={top} width={barW} height={Math.max(1, PAD.top + plotH - top)} rx={1.5}>
                <title>{`${formatDay(p.date)}: ${p.rate}% (${p.present} de ${p.registered})`}</title>
              </rect>
            );
          })}
        </g>
        <g className="text-gray-500" fill="currentColor" fontSize="10">
          {labelIdx.map((i, k) => (
            <text
              key={points[i].date}
              x={PAD.left + slot * i + slot / 2}
              y={H - 8}
              textAnchor={k === 0 && labelIdx.length > 1 ? 'start' : k === labelIdx.length - 1 && labelIdx.length > 1 ? 'end' : 'middle'}
            >
              {shortDay(points[i].date)}
            </text>
          ))}
        </g>
      </svg>

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-blue-700">Ver valores</summary>
        <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-200">
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">Data</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Presentes</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Registros</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Frequência</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
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
