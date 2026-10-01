import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Event, EventInsert, EventUpdate, EventGroup, Group } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';

export interface EventWithGroups extends Event {
  group_ids: string[];
  group_names: string[];
}

type EgRow = { event_id: string; group_id: string; groups: { name: string } | null };

function attachGroups(events: Event[], egRows: EgRow[]): EventWithGroups[] {
  const groupMap: Record<string, { ids: string[]; names: string[] }> = {};
  for (const row of egRows) {
    if (!groupMap[row.event_id]) groupMap[row.event_id] = { ids: [], names: [] };
    groupMap[row.event_id].ids.push(row.group_id);
    groupMap[row.event_id].names.push(row.groups?.name ?? '—');
  }
  return events.map((ev) => ({
    ...ev,
    group_ids: groupMap[ev.id]?.ids ?? [],
    group_names: groupMap[ev.id]?.names ?? [],
  }));
}

async function loadEvents(): Promise<EventWithGroups[]> {
  // RLS filtra automaticamente por role
  const [evRes, egRes] = await Promise.all([
    (supabase as any).from('events').select('*').order('event_date', { ascending: false }),
    (supabase as any).from('event_groups').select('event_id, group_id, groups:group_id(name)'),
  ]);
  if (evRes.error) throw evRes.error;
  if (egRes.error) throw egRes.error;
  return attachGroups((evRes.data ?? []) as Event[], (egRes.data ?? []) as EgRow[]);
}

export function useEvents() {
  const { user, role } = useAuth();
  const [events, setEvents] = useState<EventWithGroups[]>([]);
  // Só usado pelo formulário de criação/edição; carregado sob demanda (fetchAllGroups),
  // não precisa fazer parte da consulta inicial da lista de encontros.
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setEvents(await loadEvents());
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar encontros.'));
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Carrega grupos disponíveis para seleção no formulário
  const fetchAllGroups = useCallback(async () => {
    const { data, error: e } = await (supabase as any)
      .from('groups')
      .select('id, name, leader_id')
      .order('name', { ascending: true });
    if (e) { setError(errorMessage(e)); return; }
    setAllGroups((data as Group[]) ?? []);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadEvents()
      .then((evs) => { if (!cancelled) setEvents(evs); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar encontros.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  // Sincroniza event_groups: deleta tudo e re-insere
  async function syncEventGroups(eventId: string, groupIds: string[]): Promise<boolean> {
    const { error: delErr } = await (supabase as any)
      .from('event_groups')
      .delete()
      .eq('event_id', eventId);
    if (delErr) { setError(errorMessage(delErr)); return false; }

    if (groupIds.length === 0) return true;

    const rows: EventGroup[] = groupIds.map((gid) => ({ event_id: eventId, group_id: gid }));
    const { error: insErr } = await (supabase as any).from('event_groups').insert(rows);
    if (insErr) { setError(errorMessage(insErr)); return false; }
    return true;
  }

  const createEvent = async (
    payload: Omit<EventInsert, 'created_by'>,
    groupIds: string[]
  ): Promise<Event | null> => {
    if (!user) return null;
    setError(null);
    const insert: EventInsert = { ...payload, created_by: user.id };
    const { data, error: e } = await (supabase as any)
      .from('events').insert(insert).select().single();
    if (e) { setError(errorMessage(e)); return null; }
    await syncEventGroups((data as Event).id, groupIds);
    await fetchEvents();
    return data as Event;
  };

  const updateEvent = async (
    id: string,
    payload: EventUpdate,
    groupIds: string[]
  ): Promise<Event | null> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('events').update(payload).eq('id', id).select().single();
    if (e) { setError(errorMessage(e)); return null; }
    await syncEventGroups(id, groupIds);
    await fetchEvents();
    return data as Event;
  };

  const deleteEvent = async (id: string): Promise<boolean> => {
    if (role !== 'coordinator') return false;
    setError(null);
    const { error: e } = await (supabase as any).from('events').delete().eq('id', id);
    if (e) { setError(errorMessage(e)); return false; }
    await fetchEvents();
    return true;
  };

  return {
    events,
    allGroups,
    loading,
    error,
    role,
    user,
    refetch: fetchEvents,
    fetchAllGroups,
    createEvent,
    updateEvent,
    deleteEvent,
  };
}
