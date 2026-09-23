'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button, Field, Textarea } from '@passport/ui-kit';

/**
 * Reads a QR code with the camera (`html5-qrcode`, loaded only when the person turns the camera on) or from a
 * pasted text payload. Calls `onResult` once per code.
 */
export function Scanner({ onResult, label = 'Or paste the code' }: { onResult: (text: string) => void; label?: string }) {
  const id = `qr-${useId().replace(/:/g, '')}`;
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const done = useRef(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (!camera) return;
    let stopped = false;
    let scanner: { stop(): Promise<void>; clear(): void } | null = null;
    (async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (stopped) return;
        const s = new Html5Qrcode(id);
        scanner = s;
        await s.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          (text) => {
            if (done.current) return;
            done.current = true;
            setCamera(false);
            onResultRef.current(text);
          },
          undefined,
        );
      } catch {
        setCameraError('The camera could not be opened here; paste the code instead.');
        setCamera(false);
      }
    })();
    return () => {
      stopped = true;
      if (scanner) {
        const s = scanner;
        void s
          .stop()
          .catch(() => undefined)
          .then(() => s.clear());
      }
    };
  }, [camera, id]);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div id={id} className="overflow-hidden rounded-2xl" style={{ maxWidth: 320, display: camera ? 'block' : 'none' }} />
        {camera ? (
          <Button variant="secondary" onClick={() => setCamera(false)}>
            Stop the camera
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              done.current = false;
              setCameraError(null);
              setCamera(true);
            }}
          >
            Scan with the camera
          </Button>
        )}
        {cameraError ? <p className="text-sm muted">{cameraError}</p> : null}
      </div>
      <Field label={label} htmlFor={`${id}-paste`}>
        <Textarea id={`${id}-paste`} value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} placeholder='{"type":"org.bioregion…' />
      </Field>
      <div>
        <Button disabled={!pasted.trim()} onClick={() => onResultRef.current(pasted.trim())}>
          Use this code
        </Button>
      </div>
    </div>
  );
}
