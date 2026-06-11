const auth = { username: 'admin', password: '' };
const coll = '/db/cypress-rawbin';
const enc = encodeURIComponent;

// Path-in-URL raw resource transport: GET/PUT /api/resource/{path}
// (existdb-openapi#35/#38). Binary-safe — the response is streamed raw, not run
// through the serializer (which would emit base64 text and corrupt binaries).
// Self-contained: creates its own collection.
describe('/api/resource/{path} — raw (binary-safe) transport', () => {
  before(() => {
    cy.request({ url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false, body: { path: coll } });
  });
  after(() => {
    cy.request({ url: `/api/db/collection?path=${enc(coll)}&force=true`, method: 'DELETE', auth, failOnStatusCode: false });
  });

  it('PUT then GET round-trips raw content (not base64-mangled)', () => {
    // octet-stream stores as binary; the GET must return the bytes, not base64.
    // A base64 round-trip would change the value (and length), so equality catches it.
    const content = 'raw-bytes-not-b64-payload';
    cy.request({
      url: `/api/resource/db/cypress-rawbin/blob.bin`, method: 'PUT', auth,
      headers: { 'Content-Type': 'application/octet-stream' }, body: content
    }).then(r => expect(r.status).to.be.oneOf([200, 201]));
    cy.request({ url: `/api/resource/db/cypress-rawbin/blob.bin`, auth }).then(r => {
      expect(r.status).to.eq(200);
      expect(r.body).to.eq(content);
    });
  });

  it('PUT 201 on create, 200 on overwrite; returns stored + runPath', () => {
    cy.request({
      url: `/api/resource/db/cypress-rawbin/again.bin`, method: 'PUT', auth,
      headers: { 'Content-Type': 'application/octet-stream' }, body: 'one'
    }).then(r => {
      expect(r.status).to.eq(201);
      expect(r.body).to.have.property('stored', '/db/cypress-rawbin/again.bin');
      expect(r.body).to.have.property('runPath');
    });
    cy.request({
      url: `/api/resource/db/cypress-rawbin/again.bin`, method: 'PUT', auth,
      headers: { 'Content-Type': 'application/octet-stream' }, body: 'two'
    }).then(r => expect(r.status).to.eq(200));
  });

  it('serves an XML resource serialized with its mime type', () => {
    cy.request({
      url: `/api/resource/db/cypress-rawbin/doc.xml`, method: 'PUT', auth,
      headers: { 'Content-Type': 'application/xml' }, body: '<doc><a>hi</a></doc>'
    });
    cy.request({ url: `/api/resource/db/cypress-rawbin/doc.xml`, auth }).then(r => {
      expect(r.status).to.eq(200);
      expect(r.headers['content-type']).to.contain('application/xml');
      expect(r.body).to.contain('<a>hi</a>');
    });
  });

  it('404 for a missing resource', () => {
    cy.request({ url: `/api/resource/db/cypress-rawbin/nope.xml`, auth, failOnStatusCode: false })
      .then(r => expect(r.status).to.eq(404));
  });
});
