export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center px-6 py-20">
      <p className="eyebrow">Not found</p>
      <h1 className="mt-3 text-4xl font-medium">We could not find that page.</h1>
      <p className="mt-4 text-lg muted">
        The address may be mistyped, or the pod you are looking for has not opened yet.
      </p>
      <p className="mt-8">
        <a href="/">Go to the Bioregional Passport home page</a>
      </p>
    </main>
  );
}
