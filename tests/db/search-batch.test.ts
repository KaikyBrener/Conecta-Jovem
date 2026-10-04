import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 014 (partes C e D): global_search (INVOKER sob RLS) e ações em lote (batch_set_youth_group /
// batch_set_youth_active, INVOKER, atômicas, máx. 200).

let t: TestDb;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupA2: string, groupB: string, groupC: string;

interface SearchResult {
  youth: { id: string; full_name: string; group_name: string | null; is_active: boolean }[];
  groups: { id: string; name: string; leader_name: string | null }[];
  events: { id: string; title: string; event_date: string; status: string }[];
}
interface BatchResult { requested: number; updated: number; unchanged: number; skipped: string[] }

const pgArray = (ids: (string | null)[]) => `{${ids.map((i) => (i === null ? 'NULL' : i)).join(',')}}`;

const search = (user: string | null, q: string | null, limit?: number | null) =>
  t.as(user, async () =>
    (await t.q<{ r: SearchResult }>(
      limit === undefined ? `SELECT public.global_search($1) AS r` : `SELECT public.global_search($1, $2::int) AS r`,
      limit === undefined ? [q] : [q, limit]))[0].r);

const names = (r: SearchResult) => r.youth.map((y) => y.full_name);

let seq = 0;
async function mkYouth(name: string, group: string | null, active = true): Promise<string> {
  seq += 1;
  return (await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, group, active, coord]))[0].id;
}
async function mkEvent(title: string, groups: string[], daysAhead = 5, status = 'scheduled'): Promise<string> {
  seq += 1;
  const [e] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ($1, now() + ($2 || ' days')::interval, $3::event_status, $4) RETURNING id`,
    [title, String(daysAhead), status, coord]);
  for (const g of groups) await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [e.id, g]);
  return e.id;
}

const batchGroup = (user: string | null, ids: (string | null)[] | null, group: string | null) =>
  t.as(user, async () =>
    (await t.q<{ r: BatchResult }>(`SELECT public.batch_set_youth_group($1::uuid[], $2::uuid) AS r`,
      [ids === null ? null : pgArray(ids), group]))[0].r);

const batchActive = (user: string | null, ids: (string | null)[] | null, active: boolean | null) =>
  t.as(user, async () =>
    (await t.q<{ r: BatchResult }>(`SELECT public.batch_set_youth_active($1::uuid[], $2::boolean) AS r`,
      [ids === null ? null : pgArray(ids), active]))[0].r);

const groupOf = async (youth: string) =>
  (await t.q<{ group_id: string | null }>(`SELECT group_id FROM public.youth WHERE id = $1`, [youth]))[0].group_id;
const activeOf = async (youth: string) =>
  (await t.q<{ is_active: boolean }>(`SELECT is_active FROM public.youth WHERE id = $1`, [youth]))[0].is_active;

let jose1: string, jose2: string, josefina: string, mariaJose: string, anaB: string, semGrupo: string;
let evA: string, evB: string, evPending: string;

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder Alfa', 'leader');
  leaderB = await t.createUser('Líder Beta', 'leader');
  const mkGroup = async (name: string, leader: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leader]))[0].id;
  groupA = await mkGroup('Grupo Águia', leaderA);
  groupA2 = await mkGroup('Grupo Águia Dois', leaderA);
  groupB = await mkGroup('Grupo Beta', leaderB);
  groupC = await mkGroup('Grupo Coordenação', coord);

  jose1 = await mkYouth('José Álvaro Souza', groupA);
  jose2 = await mkYouth('JOSÉ Pereira', groupA);
  josefina = await mkYouth('Josefina Lima', groupA, false);
  mariaJose = await mkYouth('Maria José', groupB);
  anaB = await mkYouth('Ana Lúcia', groupB);
  semGrupo = await mkYouth('João Sem Grupo', null);

  evA = await mkEvent('Culto José Águia', [groupA]);
  evB = await mkEvent('Retiro de Jovens', [groupB]);
  evPending = await mkEvent('Evento José pendente', []);
}, 60_000);

describe('search_norm', () => {
  it('minúsculas e sem acentos (maiúsculas acentuadas incluídas)', async () => {
    const [r] = await t.q<{ a: string; b: string }>(
      `SELECT public.search_norm('ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ') AS a, public.search_norm('áàâãäåéèêëíìîïóòôõöúùûüçñ Ab') AS b`);
    expect(r.a).toBe('aaaaaaeeeeiiiiooooouuuucn');
    expect(r.b).toBe('aaaaaaeeeeiiiiooooouuuucn ab');
  });
});

describe('global_search — coordenador', () => {
  it('forma do JSON e itens', async () => {
    const r = await search(coord, 'jose');
    expect(Object.keys(r).sort()).toEqual(['events', 'groups', 'youth']);
    expect(Object.keys(r.youth[0]).sort()).toEqual(['full_name', 'group_name', 'id', 'is_active']);
    expect(r.youth[0]).toEqual({ id: jose1, full_name: 'José Álvaro Souza', group_name: 'Grupo Águia', is_active: true });
    const rg = await search(coord, 'aguia');
    expect(Object.keys(rg.groups[0]).sort()).toEqual(['id', 'leader_name', 'name']);
    expect(rg.groups[0]).toEqual({ id: groupA, name: 'Grupo Águia', leader_name: 'Líder Alfa' });
    expect(Object.keys(r.events[0]).sort()).toEqual(['event_date', 'id', 'status', 'title']);
  });

  it('insensível a caixa e acento nos dois sentidos; inclui inativos e jovens sem grupo', async () => {
    const a = await search(coord, 'jose');
    const b = await search(coord, 'JOSÉ');
    const c = await search(coord, 'jOsÉ');
    expect(names(b)).toEqual(names(a));
    expect(names(c)).toEqual(names(a));
    expect(names(a)).toEqual(['José Álvaro Souza', 'JOSÉ Pereira', 'Josefina Lima', 'Maria José']);
    expect(a.youth.find((y) => y.full_name === 'Josefina Lima')?.is_active).toBe(false);
    const sg = await search(coord, 'sem grupo');
    expect(sg.youth).toEqual([{ id: semGrupo, full_name: 'João Sem Grupo', group_name: null, is_active: true }]);
    // acento no banco, termo sem acento (e vice-versa)
    expect(names(await search(coord, 'lucia'))).toEqual(['Ana Lúcia']);
    expect(names(await search(coord, 'LÚCIA'))).toEqual(['Ana Lúcia']);
  });

  it('relevância: começa com o termo, depois começa uma palavra, depois contém; desempate por nome', async () => {
    const r = await search(coord, 'jose');
    // prefixo: José Álvaro Souza, JOSÉ Pereira, Josefina Lima (ordem por nome); palavra: Maria José
    expect(names(r).indexOf('Maria José')).toBe(3);
    await mkYouth('Rejose Contém', groupC);
    const r2 = await search(coord, 'jose');
    expect(names(r2)).toEqual(['José Álvaro Souza', 'JOSÉ Pereira', 'Josefina Lima', 'Maria José', 'Rejose Contém']);
  });

  it('eventos e grupos; encontro sem grupo aparece para o coordenador', async () => {
    const r = await search(coord, 'jose');
    expect(r.events.map((e) => e.title)).toEqual(['Culto José Águia', 'Evento José pendente']);
    expect(r.events.every((e) => e.status === 'scheduled')).toBe(true);
    const g = await search(coord, 'grupo');
    expect(g.groups.map((x) => x.name)).toEqual(['Grupo Águia', 'Grupo Águia Dois', 'Grupo Beta', 'Grupo Coordenação']);
  });
});

describe('global_search — líder (RLS)', () => {
  it('líder A só enxerga jovens, grupos e encontros do próprio escopo', async () => {
    const r = await search(leaderA, 'jose');
    expect(names(r)).toEqual(['José Álvaro Souza', 'JOSÉ Pereira', 'Josefina Lima']); // sem Maria José (grupo B)
    expect(r.events.map((e) => e.title)).toEqual(['Culto José Águia']);               // sem o encontro pendente
    const g = await search(leaderA, 'grupo');
    expect(g.groups.map((x) => x.name)).toEqual(['Grupo Águia', 'Grupo Águia Dois']);
    expect(g.groups.every((x) => x.leader_name === 'Líder Alfa')).toBe(true);
    expect((await search(leaderA, 'beta')).groups).toEqual([]);
    expect((await search(leaderA, 'retiro')).events).toEqual([]);
    expect(names(await search(leaderA, 'sem grupo'))).toEqual([]);
  });

  it('líder B vê o seu lado; sem sessão -> erro de permissão', async () => {
    expect(names(await search(leaderB, 'jose'))).toEqual(['Maria José']);
    expect((await search(leaderB, 'retiro')).events.map((e) => e.id)).toEqual([evB]);
    await expect(search(null, 'jose')).rejects.toThrow(/permission denied/);
  });
});

describe('global_search — entrada', () => {
  const EMPTY = { youth: [], groups: [], events: [] };

  it('vazio, nulo, espaços e menos de 2 caracteres => listas vazias (sem erro)', async () => {
    for (const q of [null, '', '   ', 'a', ' j ', 'é']) {
      expect(await search(coord, q), String(q)).toEqual(EMPTY);
    }
  });

  it('curingas e separadores são removidos/escapados: não casam tudo nem injetam filtro', async () => {
    for (const q of ['%', '%%', '__', '_%_', '\\', '\\%', '*', ',', '()', '"', '%_%', '  %  ', 'a_', 'j%', '%e']) {
      expect(await search(coord, q), q).toEqual(EMPTY);
    }
    // "jo%se" vira "jo se" (o % não é curinga): ninguém tem "jo se"
    expect(await search(coord, 'jo%se')).toEqual(EMPTY);
    expect(await search(coord, 'jo_e')).toEqual(EMPTY);
    // tentativa de injeção é só texto
    expect(await search(coord, `' OR 1=1 --`)).toEqual(EMPTY);
    expect(await search(coord, `jose'); DROP TABLE public.youth; --`)).toEqual(EMPTY);
    expect(await search(coord, `%jose%`)).toMatchObject({ youth: expect.any(Array) });
    const [{ n }] = await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.youth`);
    expect(Number(n)).toBeGreaterThan(5);
  });

  it('separadores viram espaço: "José,Pereira" encontra "JOSÉ Pereira"', async () => {
    expect(names(await search(coord, 'José,Pereira'))).toEqual(['JOSÉ Pereira']);
    expect(names(await search(coord, '(jose)  *pereira*'))).toEqual(['JOSÉ Pereira']);
  });

  it('limite: padrão 8, mínimo 1, máximo 20 por categoria', async () => {
    for (let i = 1; i <= 25; i++) await mkYouth(`Zeta ${String(i).padStart(2, '0')}`, groupC);
    expect((await search(coord, 'zeta')).youth).toHaveLength(8);
    expect((await search(coord, 'zeta', null)).youth).toHaveLength(8);
    expect((await search(coord, 'zeta', 3)).youth).toHaveLength(3);
    expect((await search(coord, 'zeta', 0)).youth).toHaveLength(1);
    expect((await search(coord, 'zeta', -5)).youth).toHaveLength(1);
    const big = await search(coord, 'zeta', 1000);
    expect(big.youth).toHaveLength(20);
    expect(names(big).slice(0, 3)).toEqual(['Zeta 01', 'Zeta 02', 'Zeta 03']);
  });

  it('índices btree de busca existem', async () => {
    const idx = await t.q<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('youth_name_search_idx', 'groups_name_search_idx', 'events_title_search_idx') ORDER BY 1`);
    expect(idx.map((i) => i.indexname)).toEqual(['events_title_search_idx', 'groups_name_search_idx', 'youth_name_search_idx']);
  });
});

describe('batch_set_youth_group', () => {
  it('coordenador move vários jovens; JSON exato; já no destino conta como unchanged', async () => {
    const a = await mkYouth('Lote 1', groupC);
    const b = await mkYouth('Lote 2', groupC);
    const c = await mkYouth('Lote 3', groupA);
    const ghost = crypto.randomUUID();
    const r = await batchGroup(coord, [a, b, c, ghost, a, null], groupA);
    expect(r).toEqual({ requested: 4, updated: 2, unchanged: 1, skipped: [ghost] });
    expect(await groupOf(a)).toBe(groupA);
    expect(await groupOf(b)).toBe(groupA);
    // desassociar
    const r2 = await batchGroup(coord, [a, b], null);
    expect(r2).toEqual({ requested: 2, updated: 2, unchanged: 0, skipped: [] });
    expect(await groupOf(a)).toBeNull();
  });

  it('o grupo do histórico de chamada segue o jovem (trigger de sincronização continua valendo)', async () => {
    const y = await mkYouth('Lote Histórico', groupA);
    const ev = await mkEvent('Culto histórico', [groupA, groupC], -1, 'completed');
    await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, NULL)`,
      [ev, y, groupA]);
    await batchGroup(coord, [y], groupC);
    const [row] = await t.q<{ group_id: string }>(`SELECT group_id FROM public.attendance WHERE youth_id = $1`, [y]);
    expect(row.group_id).toBe(groupC);
  });

  it('líder: só jovens que enxerga; fora do escopo vai para skipped (nada é alterado)', async () => {
    const own = await mkYouth('Lote Líder Próprio', groupA);
    const own2 = await mkYouth('Lote Líder Próprio 2', groupA);
    const foreign = await mkYouth('Lote Alheio', groupB);
    const r = await batchGroup(leaderA, [own, own2, foreign], null);
    expect(r).toEqual({ requested: 3, updated: 2, unchanged: 0, skipped: [foreign] });
    expect(await groupOf(own)).toBeNull();
    expect(await groupOf(foreign)).toBe(groupB);
  });

  it('documenta o RLS atual: UPDATE direto do líder com group_id = NULL falha (por isso o lote é DEFINER)', async () => {
    const y = await mkYouth('Lote Direto', groupA);
    await expect(t.as(leaderA, () => t.q(`UPDATE public.youth SET group_id = NULL WHERE id = $1`, [y]))).rejects.toThrow(/row-level security/i);
    expect(await groupOf(y)).toBe(groupA);
    expect(await batchGroup(leaderA, [y], null)).toEqual({ requested: 1, updated: 1, unchanged: 0, skipped: [] });
    expect(await groupOf(y)).toBeNull();
  });

  it('líder: mover entre grupos seus funciona; para grupo alheio/inexistente falha inteiro', async () => {
    const y1 = await mkYouth('Lote Move 1', groupA);
    const y2 = await mkYouth('Lote Move 2', groupA);
    expect(await batchGroup(leaderA, [y1, y2], groupA2)).toMatchObject({ updated: 2, skipped: [] });
    expect(await groupOf(y1)).toBe(groupA2);

    await expect(batchGroup(leaderA, [y1, y2], groupB)).rejects.toThrow(/Grupo não encontrado ou sem permissão/);
    await expect(batchGroup(leaderA, [y1], groupC)).rejects.toThrow(/Grupo não encontrado ou sem permissão/);
    await expect(batchGroup(coord, [y1], crypto.randomUUID())).rejects.toThrow(/Grupo não encontrado/);
    expect(await groupOf(y1)).toBe(groupA2);
    expect(await groupOf(y2)).toBe(groupA2);
    // jovem de outro líder nunca é movido para o grupo do líder
    const foreign = await mkYouth('Lote Roubo', groupB);
    expect(await batchGroup(leaderA, [foreign], groupA)).toEqual({ requested: 1, updated: 0, unchanged: 0, skipped: [foreign] });
    expect(await groupOf(foreign)).toBe(groupB);
  });

  it('limites: vazio/nulo => erro; 200 distintos ok; 201 => erro; repetidos contam uma vez', async () => {
    await expect(batchGroup(coord, [], groupA)).rejects.toThrow(/Selecione ao menos um jovem/);
    await expect(batchGroup(coord, null, groupA)).rejects.toThrow(/Selecione ao menos um jovem/);
    await expect(batchGroup(coord, [null], groupA)).rejects.toThrow(/Selecione ao menos um jovem/);
    const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
    const ok = await batchGroup(coord, ids, groupA);
    expect(ok).toMatchObject({ requested: 200, updated: 0, unchanged: 0 });
    expect(ok.skipped).toHaveLength(200);
    await expect(batchGroup(coord, [...ids, crypto.randomUUID()], groupA)).rejects.toThrow(/no máximo 200/);
    expect(await batchGroup(coord, [...ids, ...ids], groupA)).toMatchObject({ requested: 200 });
  });

  it('atômico: erro no meio do lote desfaz tudo', async () => {
    const ok1 = await mkYouth('Atomico 1', groupC);
    const boom = await mkYouth('Atomico Explode', groupC);
    const ok2 = await mkYouth('Atomico 2', groupC);
    await t.db.exec(`
      CREATE FUNCTION public.test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha simulada'; END $$;
      CREATE TRIGGER test_boom BEFORE UPDATE ON public.youth FOR EACH ROW
        WHEN (NEW.full_name = 'Atomico Explode') EXECUTE PROCEDURE public.test_boom();`);
    try {
      await expect(batchGroup(coord, [ok1, boom, ok2], groupA)).rejects.toThrow(/falha simulada/);
      await expect(batchActive(coord, [ok1, boom, ok2], false)).rejects.toThrow(/falha simulada/);
    } finally {
      await t.db.exec(`DROP TRIGGER test_boom ON public.youth; DROP FUNCTION public.test_boom();`);
    }
    expect(await groupOf(ok1)).toBe(groupC);
    expect(await groupOf(ok2)).toBe(groupC);
    expect(await activeOf(ok1)).toBe(true);
    expect(await activeOf(ok2)).toBe(true);
  });

  it('permissões: anon sem EXECUTE; usuário sem papel recusado', async () => {
    await expect(batchGroup(null, [jose1], groupA)).rejects.toThrow(/permission denied/);
    await expect(batchGroup(crypto.randomUUID(), [jose1], null)).rejects.toThrow(/Sem permissão/);
  });
});

describe('batch_set_youth_active', () => {
  it('inativa e reativa em lote; unchanged e skipped; p_active nulo => erro', async () => {
    const a = await mkYouth('Ativo 1', groupC);
    const b = await mkYouth('Ativo 2', groupC, false);
    const ghost = crypto.randomUUID();
    expect(await batchActive(coord, [a, b, ghost], false)).toEqual({ requested: 3, updated: 1, unchanged: 1, skipped: [ghost] });
    expect(await activeOf(a)).toBe(false);
    expect(await batchActive(coord, [a, b], true)).toEqual({ requested: 2, updated: 2, unchanged: 0, skipped: [] });
    expect(await activeOf(b)).toBe(true);
    await expect(batchActive(coord, [a], null)).rejects.toThrow(/ativos ou inativos/);
    await expect(batchActive(coord, [], true)).rejects.toThrow(/Selecione ao menos um jovem/);
    await expect(batchActive(coord, Array.from({ length: 201 }, () => crypto.randomUUID()), true)).rejects.toThrow(/no máximo 200/);
  });

  it('líder: respeita o RLS (só os seus jovens)', async () => {
    const own = await mkYouth('Ativo Líder', groupA);
    const foreign = await mkYouth('Ativo Alheio', groupB);
    const r = await batchActive(leaderA, [own, foreign], false);
    expect(r).toEqual({ requested: 2, updated: 1, unchanged: 0, skipped: [foreign] });
    expect(await activeOf(own)).toBe(false);
    expect(await activeOf(foreign)).toBe(true);
    await expect(batchActive(null, [own], true)).rejects.toThrow(/permission denied/);
  });

  it('inativar resolve os alertas abertos dos jovens (triggers existentes disparam)', async () => {
    const y1 = await mkYouth('Alerta 1', groupC);
    const y2 = await mkYouth('Alerta 2', groupC);
    for (let i = 1; i <= 3; i++) {
      const ev = await mkEvent(`Culto passado ${i}`, [groupC], -30 + i, 'completed');
      for (const y of [y1, y2]) {
        await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, false, NULL)`,
          [ev, y, groupC]);
      }
    }
    const open = () => t.q<{ youth_id: string; status: string }>(
      `SELECT youth_id, status::text AS status FROM public.alerts
        WHERE youth_id = ANY($1::uuid[]) AND type = 'consecutive_absences' ORDER BY youth_id`, [pgArray([y1, y2])]);
    expect((await open()).map((a) => a.status)).toEqual(['open', 'open']);

    await batchActive(coord, [y1, y2], false);
    const after = await open();
    expect(after).toHaveLength(2);
    expect(after.every((a) => a.status === 'resolved')).toBe(true);
    const [note] = await t.q<{ resolution_notes: string }>(
      `SELECT resolution_notes FROM public.alerts WHERE youth_id = $1 AND type = 'consecutive_absences'`, [y1]);
    expect(note.resolution_notes).toMatch(/inativado/);
    // sem duplicar: reativar não recria enquanto... o recálculo reabre um alerta novo (histórico preservado)
    await batchActive(coord, [y1, y2], true);
    const again = await t.q<{ status: string }>(
      `SELECT status::text AS status FROM public.alerts WHERE youth_id = $1 AND type = 'consecutive_absences' ORDER BY created_at`, [y1]);
    expect(again.filter((a) => a.status === 'open')).toHaveLength(1);
  });
});

describe('grants', () => {
  it('RPCs só para authenticated e SECURITY INVOKER (RLS vale)', async () => {
    const privs = await t.q<{ proname: string; anon: boolean; authed: boolean; definer: boolean }>(
      `SELECT p.proname, p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('global_search', 'batch_set_youth_group', 'batch_set_youth_active', 'search_norm')`);
    expect(privs).toHaveLength(4);
    for (const p of privs) {
      // batch_set_youth_group é DEFINER com escopo explícito (o RLS de youth impede o líder de desassociar jovens)
      expect(p, p.proname).toMatchObject({ anon: false, authed: true, definer: p.proname === 'batch_set_youth_group' });
    }
    const [cfg] = await t.q<{ cfg: string }>(
      `SELECT proconfig::text AS cfg FROM pg_proc WHERE proname = 'batch_set_youth_group' AND pronamespace = 'public'::regnamespace`);
    expect(cfg.cfg).toContain('search_path=public');
  });
});
