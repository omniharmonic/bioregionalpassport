/** Not-found inside a pod: renders within the pod layout, which already provides `<main>`. */
export default function PodNotFound() {
  return (
    <div className="grid gap-4 py-10">
      <p className="eyebrow">Not found</p>
      <h1 className="text-3xl font-medium">We could not find that page.</h1>
      <p className="muted">The address may be mistyped, or this part of the pod has not opened yet.</p>
      <p>
        <a href="./">Back to the pod home page</a>
      </p>
    </div>
  );
}
