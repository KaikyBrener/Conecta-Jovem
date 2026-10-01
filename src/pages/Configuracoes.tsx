import { useState } from 'react';
import { Loader2, RefreshCw, Save, ShieldCheck, User as UserIcon, SlidersHorizontal, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useAppSettings, useUserManagement, updateOwnName, updateOwnPassword } from '../hooks/useSettings';
import { ErrorBanner, SuccessBanner } from '../components/ErrorBanner';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { inputCls, labelCls, primaryBtnCls as primaryBtn, secondaryBtnCls } from '../lib/formStyles';
import { formatDateTime } from '../lib/format';
import type { AppSettings, Role } from '../types/database.types';

function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
      <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <Icon className="w-5 h-5 text-blue-600" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function ProfileSection() {
  const { user, profile, role, refreshProfile } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'name' | 'password' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setOk(null);
    if (!user) return;
    if (!name.trim()) { setErr('Informe seu nome.'); return; }
    setBusy('name');
    const error = await updateOwnName(user.id, name.trim());
    setBusy(null);
    if (error) { setErr(error); return; }
    await refreshProfile();
    setOk('Nome atualizado.');
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setOk(null);
    if (password.length < 6) { setErr('A senha deve ter pelo menos 6 caracteres.'); return; }
    if (password !== confirm) { setErr('As senhas não conferem.'); return; }
    setBusy('password');
    const error = await updateOwnPassword(password);
    setBusy(null);
    if (error) { setErr(error); return; }
    setPassword(''); setConfirm('');
    setOk('Senha alterada.');
  };

  return (
    <Section icon={UserIcon} title="Meu perfil">
      <ErrorBanner message={err} />
      <SuccessBanner message={ok} />
      <p className="text-sm text-gray-500">
        {user?.email} · {role === 'coordinator' ? 'Coordenador' : 'Líder'}
      </p>
      <form onSubmit={saveName} className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <label className={labelCls} htmlFor="profile-name">Nome</label>
          <input id="profile-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" disabled={busy !== null} className={primaryBtn}>
          {busy === 'name' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Salvar nome
        </button>
      </form>
      <form onSubmit={savePassword} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] sm:items-end gap-3">
        <div>
          <label className={labelCls} htmlFor="pw1">Nova senha</label>
          <input id="pw1" type="password" autoComplete="new-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="pw2">Confirmar senha</label>
          <input id="pw2" type="password" autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <button type="submit" disabled={busy !== null || !password} className={primaryBtn}>
          {busy === 'password' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          Alterar senha
        </button>
      </form>
    </Section>
  );
}

function SettingsForm({ settings, onSave, onRecalculate }: {
  settings: AppSettings;
  onSave: (absence: number, low: number) => Promise<boolean>;
  onRecalculate: () => Promise<number | null>;
}) {
  const [absence, setAbsence] = useState(String(settings.absence_alert_threshold));
  const [low, setLow] = useState(String(settings.low_attendance_threshold));
  const [busy, setBusy] = useState<'save' | 'recalc' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setOk(null);
    const a = Number(absence);
    const l = Number(low);
    if (!Number.isInteger(a) || a < 1 || a > 20) { setErr('Faltas consecutivas: informe um número inteiro entre 1 e 20.'); return; }
    if (!Number.isInteger(l) || l < 0 || l > 100) { setErr('Frequência mínima: informe um número inteiro entre 0 e 100.'); return; }
    setBusy('save');
    const saved = await onSave(a, l);
    setBusy(null);
    if (saved) setOk('Configurações salvas. Os alertas foram recalculados.');
  };

  const recalc = async () => {
    setErr(null); setOk(null);
    setBusy('recalc');
    const n = await onRecalculate();
    setBusy(null);
    if (n !== null) setOk(`Alertas recalculados para ${n} jovem(ns).`);
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <ErrorBanner message={err} />
      <SuccessBanner message={ok} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls} htmlFor="abs">Faltas consecutivas para gerar alerta</label>
          <input id="abs" type="number" min={1} max={20} className={inputCls} value={absence} onChange={(e) => setAbsence(e.target.value)} />
          <p className="mt-1 text-xs text-gray-500">O alerta é criado automaticamente ao salvar a chamada.</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="low">Frequência mínima esperada (%)</label>
          <input id="low" type="number" min={0} max={100} className={inputCls} value={low} onChange={(e) => setLow(e.target.value)} />
          <p className="mt-1 text-xs text-gray-500">Jovens abaixo deste percentual são destacados no painel e nos relatórios.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-400">Última alteração: {formatDateTime(settings.updated_at)}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={recalc} disabled={busy !== null} className={secondaryBtnCls}>
            {busy === 'recalc' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Recalcular alertas
          </button>
          <button type="submit" disabled={busy !== null} className={primaryBtn}>
            {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar
          </button>
        </div>
      </div>
    </form>
  );
}

function SystemSection() {
  const { settings, loading, error, updateSettings, recalculateAlerts } = useAppSettings();

  return (
    <Section icon={SlidersHorizontal} title="Parâmetros de acompanhamento">
      <ErrorBanner message={error} />
      {loading ? (
        <LoadingBlock size="sm" />
      ) : settings ? (
        <SettingsForm
          key={settings.updated_at}
          settings={settings}
          onSave={(a, l) => updateSettings({ absence_alert_threshold: a, low_attendance_threshold: l })}
          onRecalculate={recalculateAlerts}
        />
      ) : (
        <p className="text-sm text-gray-500">
          Configurações não encontradas. Verifique se a migration <code>006_settings_alerts_tasks.sql</code> foi aplicada.
        </p>
      )}
    </Section>
  );
}

function UsersSection() {
  const { user } = useAuth();
  const { users, loading, error, setUserRole } = useUserManagement(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const change = async (id: string, role: Role) => {
    setBusyId(id);
    await setUserRole(id, role);
    setBusyId(null);
  };

  return (
    <Section icon={Users} title="Usuários e papéis">
      <p className="text-sm text-gray-500">
        Novos usuários são cadastrados no painel do Supabase (Authentication → Users) e entram como líderes.
        Aqui você define quem é coordenador.
      </p>
      <ErrorBanner message={error} />
      {loading ? (
        <LoadingBlock size="sm" />
      ) : users.length === 0 ? (
        <p className="text-sm text-gray-500">Nenhum usuário encontrado.</p>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {u.full_name || 'Sem nome'} {u.id === user?.id && <span className="text-xs text-gray-400">(você)</span>}
                </p>
                <p className="text-xs text-gray-500">Desde {formatDateTime(u.created_at)}</p>
              </div>
              <div className="flex items-center gap-2">
                {busyId === u.id && <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />}
                <select
                  value={u.role}
                  disabled={busyId !== null}
                  onChange={(e) => change(u.id, e.target.value as Role)}
                  className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
                  aria-label={`Papel de ${u.full_name ?? 'usuário'}`}
                >
                  <option value="leader">Líder</option>
                  <option value="coordinator">Coordenador</option>
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function Configuracoes() {
  const { role } = useAuth();
  const isCoordinator = role === 'coordinator';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Configurações"
        subtitle={isCoordinator ? 'Seu perfil, parâmetros do sistema e usuários.' : 'Seu perfil e senha.'}
      />
      <ProfileSection />
      {isCoordinator && <SystemSection />}
      {isCoordinator && <UsersSection />}
    </div>
  );
}
