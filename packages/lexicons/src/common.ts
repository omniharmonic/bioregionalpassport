import { z } from 'zod';

/** ISO-8601 timestamp string. */
export const isoDateTime = () => z.iso.datetime({ offset: true });

/** Latitude in degrees. */
export const latitude = () => z.number().min(-90).max(90);

/** Longitude in degrees. */
export const longitude = () => z.number().min(-180).max(180);

/** Every open record carries the pod's slug it was authored in. */
export const bioregion = () => z.string().min(1);

/** Most records may optionally reference a spatial place. */
export const optionalPlaceId = () => z.string().min(1).optional();

/** Valueflows-style quantity: a value with its unit. */
export const QuantitySchema = z.object({
  unit: z.string().min(1),
  value: z.number(),
});
export type Quantity = z.infer<typeof QuantitySchema>;
