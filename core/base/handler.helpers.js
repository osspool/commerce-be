export function makeGetBySlugHandler(controller) {
  return async function getBySlug(request, reply) {
    const slug = request.validated?.params?.slug || request.params.slug;
    const doc = await controller.service.getByQuery({ slug });
    reply.code(200).send({ success: true, data: doc });
  };
}

export default {
  makeGetBySlugHandler,
};
