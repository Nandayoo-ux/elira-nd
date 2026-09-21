export async function verifyThenCleanup({ verify, cleanup }) {
  let primaryFailure
  try {
    await verify()
  } catch (error) {
    primaryFailure = error
  }

  const cleanupFailures = []
  for (const step of cleanup) {
    try {
      await step()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }

  if (primaryFailure !== undefined) {
    if (cleanupFailures.length && typeof primaryFailure === 'object' && primaryFailure !== null) {
      Object.defineProperty(primaryFailure, 'cleanupFailures', {
        value: cleanupFailures,
        configurable: true,
      })
    }
    throw primaryFailure
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'Runtime fixture cleanup failed')
}
