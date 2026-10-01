import { AlertCircle, CheckCircle2 } from 'lucide-react';

export function ErrorBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
      <AlertCircle className="w-4 h-4 flex-shrink-0" />
      {message}
    </div>
  );
}

export function SuccessBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
      <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
      {message}
    </div>
  );
}
