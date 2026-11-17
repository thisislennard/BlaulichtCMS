import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/ui/Icon';
import { Dialog } from '../../components/ui/overlays';
import { InputDialog } from './Inputs';
import { OutputDialog } from './Outputs';
import type { Catalog, SlotPreset } from './shared';

/*
 * Auslöser oder Aktion direkt aus dem Workflow anlegen (ohne Seitenwechsel): erst die Art wählen (nur passende, falls ein
 * Platz aus einer Vorlage sie vorgibt), dann dasselbe Formular wie unter Workflows → Auslöser bzw. Aktionen.
 */
export interface CreateRefRequest {
  type: 'input' | 'output';
  /** erlaubte Arten (leer = alle) */
  kinds: string[];
  preset?: SlotPreset;
}

export function CreateRefDialog({ req, cat, onClose, onCreated }: { req: CreateRefRequest; cat: Catalog; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const all = req.type === 'input' ? cat.inputKinds : cat.outputKinds;
  const options = req.kinds.length ? all.filter((k) => req.kinds.includes(k.kind)) : all;
  const [kind, setKind] = useState<string | null>(options.length === 1 ? options[0].kind : null);
  const done = (saved: boolean, id?: string) => {
    if (saved && id) {
      qc.invalidateQueries({ queryKey: [req.type === 'input' ? 'automation-inputs' : 'automation-outputs'] });
      onCreated(id);
    }
    onClose();
  };
  if (kind) {
    return req.type === 'input' ? <InputDialog input={null} kind={kind} cat={cat} preset={req.preset} onClose={done} /> : <OutputDialog output={null} kind={kind} cat={cat} preset={req.preset} onClose={done} />;
  }
  return (
    <Dialog open onClose={onClose} title={req.type === 'input' ? 'Neuer Auslöser: Art wählen' : 'Neue Aktion: Art wählen'} width={620}>
      <div className="grid sm:grid-cols-2 gap-2">
        {options.map((k) => (
          <button key={k.kind} type="button" onClick={() => setKind(k.kind)} className="text-left flex gap-3 p-3 rounded-node border border-line bg-card hover:bg-raised focus-visible:shadow-ring">
            <Icon name={k.icon} size={18} className="text-fg-muted mt-0.5 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <strong className="text-sm">{k.label}</strong>
              <span className="text-meta text-fg-muted">{k.description}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
