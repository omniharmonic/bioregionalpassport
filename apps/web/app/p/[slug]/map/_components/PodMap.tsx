'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap, MapLayerMouseEvent, StyleSpecification } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Notice, Pill } from '@passport/ui-kit';
import { podDateTime } from '../../events/_lib/podTime';
import {
  COLLECTIONS,
  COLLECTION_LABEL,
  RASTER_FALLBACK_STYLE,
  VECTOR_STYLE_URL,
  cleanFeatures,
  popupFor,
  type MapCollection,
  type MapFeature,
} from '../_lib/features';

export interface PodMapProps {
  slug: string;
  /** Link base for pod pages ('' on the pod host, `/p/<slug>` on the platform host). */
  base: string;
  bounds: [[number, number], [number, number]] | null;
  timeZone: string;
  /** Record URI to centre on (`?focus=`). */
  focus: string | null;
}

const SOURCE = 'records';
const layerId = (c: MapCollection) => `records-${c}`;

/** Vector style when OpenFreeMap answers within a few seconds; raster OpenStreetMap tiles otherwise. */
async function chooseStyle(): Promise<{ style: string | StyleSpecification; vector: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(VECTOR_STYLE_URL, { signal: ctl.signal });
    if (res.ok) return { style: (await res.json()) as StyleSpecification, vector: true };
  } catch {
    // fall through to raster tiles
  } finally {
    clearTimeout(timer);
  }
  return { style: RASTER_FALLBACK_STYLE as unknown as StyleSpecification, vector: false };
}

function cssColor(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** The popup body, built from DOM nodes (record text is never parsed as HTML). */
function popupNode(p: ReturnType<typeof popupFor>): HTMLElement {
  const root = document.createElement('div');
  root.className = 'grid gap-1 text-sm';
  root.style.color = '#141826';
  const kind = document.createElement('p');
  kind.className = 'text-xs uppercase tracking-wide';
  kind.style.opacity = '0.7';
  kind.textContent = p.kind;
  const title = document.createElement('p');
  title.className = 'font-semibold';
  title.textContent = p.title;
  root.append(kind, title);
  if (p.when) {
    const when = document.createElement('p');
    when.textContent = p.when;
    root.append(when);
  }
  if (p.categories.length) {
    const cats = document.createElement('p');
    cats.textContent = p.categories.join(' · ');
    root.append(cats);
  }
  if (p.acceptsCredits) {
    const pill = document.createElement('span');
    pill.className = 'inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium';
    pill.style.background = 'color-mix(in srgb, var(--bp-accent, #D98E4A) 25%, transparent)';
    pill.textContent = 'Accepts credits';
    root.append(pill);
  }
  if (p.link) {
    const a = document.createElement('a');
    a.href = p.link.href;
    a.textContent = p.link.label;
    root.append(a);
  }
  return root;
}

export function PodMap({ slug, base, bounds, timeZone, focus }: PodMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [features, setFeatures] = useState<MapFeature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [visible, setVisible] = useState<Record<MapCollection, boolean>>({ enterprise: true, event: true, place: true });

  // Load the open records once.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/appview/map', { headers: { 'x-pod': slug, accept: 'application/geo+json, application/json' }, credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        const body: unknown = await res.json();
        if (live) setFeatures(cleanFeatures(body));
      } catch {
        if (live) setError('The map records are not available right now. Please try again in a moment.');
      }
    })();
    return () => {
      live = false;
    };
  }, [slug]);

  const counts = useMemo(() => {
    const c: Record<MapCollection, number> = { enterprise: 0, event: 0, place: 0 };
    for (const f of features ?? []) c[f.properties['collection'] as MapCollection] += 1;
    return c;
  }, [features]);

  // Build the map once the records are in.
  useEffect(() => {
    if (!container.current || features === null || mapRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ default: maplibregl }, { style }] = await Promise.all([import('maplibre-gl'), chooseStyle()]);
        if (cancelled || !container.current) return;
        const el = container.current;
        const colors: Record<MapCollection, string> = {
          enterprise: cssColor(el, '--bp-primary', '#1F5F4A'),
          event: cssColor(el, '--bp-accent', '#D98E4A'),
          place: '#6B7280',
        };
        const map = new maplibregl.Map({
          container: el,
          style,
          ...(bounds ? { bounds: bounds as LngLatBoundsLike, fitBoundsOptions: { padding: 24 } } : { center: [-105.27, 40.015], zoom: 10 }),
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

        map.on('load', () => {
          map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features } });
          for (const c of COLLECTIONS) {
            map.addLayer({
              id: layerId(c),
              type: 'circle',
              source: SOURCE,
              filter: ['==', ['get', 'collection'], c],
              paint: {
                'circle-radius': 8,
                'circle-color': colors[c],
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff',
              },
            });
            map.on('click', layerId(c), (e: MapLayerMouseEvent) => {
              const f = e.features?.[0];
              if (!f || f.geometry.type !== 'Point') return;
              const model = popupFor(f.properties ?? {}, base, (iso) => podDateTime(iso, timeZone));
              new maplibregl.Popup({ offset: 12, maxWidth: '280px' })
                .setLngLat(f.geometry.coordinates as [number, number])
                .setDOMContent(popupNode(model))
                .addTo(map);
            });
            map.on('mouseenter', layerId(c), () => (map.getCanvas().style.cursor = 'pointer'));
            map.on('mouseleave', layerId(c), () => (map.getCanvas().style.cursor = ''));
          }
          const target = focus ? features.find((f) => f.properties['uri'] === focus) : undefined;
          if (target) {
            map.jumpTo({ center: target.geometry.coordinates, zoom: 15 });
            const model = popupFor(target.properties, base, (iso) => podDateTime(iso, timeZone));
            new maplibregl.Popup({ offset: 12, maxWidth: '280px' }).setLngLat(target.geometry.coordinates).setDOMContent(popupNode(model)).addTo(map);
          }
        });
      } catch (err) {
        console.error('[map] could not start the map', err);
        if (!cancelled) setMapError('This browser could not draw the map. The places are listed below.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [features, bounds, base, focus, timeZone]);

  // Remove the map on unmount.
  useEffect(
    () => () => {
      mapRef.current?.remove();
      mapRef.current = null;
    },
    [],
  );

  // Layer toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const c of COLLECTIONS) if (map.getLayer(layerId(c))) map.setLayoutProperty(layerId(c), 'visibility', visible[c] ? 'visible' : 'none');
    };
    if (map.isStyleLoaded()) apply();
    else map.once('idle', apply);
  }, [visible]);

  // Keep the source in step if records ever change after load.
  useEffect(() => {
    const src = mapRef.current?.getSource(SOURCE) as GeoJSONSource | undefined;
    if (src && features) src.setData({ type: 'FeatureCollection', features });
  }, [features]);

  return (
    <div className="grid gap-4">
      <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
        <legend className="mb-2 text-sm font-medium">Show on the map</legend>
        {COLLECTIONS.map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={visible[c]} onChange={(e) => setVisible((v) => ({ ...v, [c]: e.target.checked }))} />
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-full"
              style={{ background: c === 'enterprise' ? 'var(--bp-primary)' : c === 'event' ? 'var(--bp-accent)' : '#6B7280' }}
            />
            {COLLECTION_LABEL[c]} ({counts[c]})
          </label>
        ))}
      </fieldset>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {mapError ? <Notice kind="warning">{mapError}</Notice> : null}

      <div
        ref={container}
        role="region"
        aria-label="Map of places, gatherings and enterprises"
        className="h-[60vh] min-h-[320px] w-full overflow-hidden rounded-xl border rule"
        style={{ background: 'color-mix(in srgb, var(--bp-fg) 4%, transparent)' }}
      />

      {features && features.length ? (
        <details>
          <summary className="cursor-pointer text-sm">List everything on the map</summary>
          <ul className="mt-3 grid gap-2 text-sm">
            {features
              .filter((f) => visible[f.properties['collection'] as MapCollection])
              .map((f) => {
                const m = popupFor(f.properties, base, (iso) => podDateTime(iso, timeZone));
                return (
                  <li key={String(f.properties['uri'])} className="flex flex-wrap items-center gap-2">
                    <span className="muted">{m.kind}:</span>
                    {m.link ? <a href={m.link.href}>{m.title}</a> : <span>{m.title}</span>}
                    {m.acceptsCredits ? <Pill tone="accent">Accepts credits</Pill> : null}
                  </li>
                );
              })}
          </ul>
        </details>
      ) : features ? (
        <p className="text-sm muted">Nothing has been placed on the map yet.</p>
      ) : null}
    </div>
  );
}
