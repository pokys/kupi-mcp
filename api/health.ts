export default {
  fetch(): Response {
    return Response.json({
      status: 'ok',
      service: 'kupi-mcp',
      transport: 'streamable-http',
      endpoint: '/api/mcp',
    });
  },
};
