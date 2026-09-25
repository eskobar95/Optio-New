/**
 * Hello-world BullMQ job processor stub.
 */
export async function processHelloWorld(taskId: string): Promise<{ ok: true; taskId: string }> {
  console.log(`[optio-new] hello-world ack taskId=${taskId}`);
  return { ok: true, taskId };
}
