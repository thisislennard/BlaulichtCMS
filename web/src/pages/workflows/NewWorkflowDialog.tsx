import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../../api/client';
import { Button, FieldWrap, Input, Textarea } from '../../components/ui/core';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { t } from '../../i18n';

/** Anlegen eines Workflows (leer oder aus Vorlage) – danach direkt in den Editor. */
export function NewWorkflowDialog({
  open,
  onClose,
  folders,
  defaultFolder = '',
  templateId,
  defaultName = '',
  title,
  footerHint,
}: {
  open: boolean;
  onClose: () => void;
  folders: string[];
  defaultFolder?: string;
  templateId?: string;
  defaultName?: string;
  title?: ReactNode;
  footerHint?: ReactNode;
}) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [folder, setFolder] = useState(defaultFolder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const errToast = useErrorToast();
  const ids = { name: useId(), desc: useId(), folder: useId(), list: useId() };

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setDescription('');
      setFolder(defaultFolder);
      setError(null);
    }
  }, [open, defaultName, defaultFolder]);

  const submit = async () => {
    if (!name.trim()) {
      setError(t('workflows.create.name') + ': Pflichtfeld');
      return;
    }
    setBusy(true);
    try {
      const w = await post<{ id: string; name: string }>('/workflows', { name: name.trim(), description: description.trim(), folder: folder.trim(), ...(templateId ? { templateId } : {}) });
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      onClose();
      navigate(`/workflows/${w.id}`);
    } catch (e) {
      errToast(e, t('workflows.toast.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? t('workflows.create.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('workflows.create.cancel')}
          </Button>
          <Button variant="primary" icon="ArrowRight" loading={busy} disabled={!name.trim()} onClick={submit}>
            {t('workflows.create.submit')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FieldWrap label={t('workflows.create.name')} htmlFor={ids.name} required error={error}>
          <Input id={ids.name} value={name} maxLength={120} placeholder={t('workflows.create.namePlaceholder')} onChange={(e) => setName(e.target.value)} invalid={!!error} required />
        </FieldWrap>
        <FieldWrap label={t('workflows.create.description')} htmlFor={ids.desc} help={t('workflows.create.descriptionHelp')}>
          <Textarea id={ids.desc} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FieldWrap>
        <FieldWrap label={t('workflows.create.folder')} htmlFor={ids.folder} help={t('workflows.create.folderHelp')}>
          <Input id={ids.folder} list={ids.list} maxLength={80} value={folder} onChange={(e) => setFolder(e.target.value)} autoComplete="off" />
          <datalist id={ids.list}>
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </FieldWrap>
        {footerHint}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
