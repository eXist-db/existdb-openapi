const auth = { username: 'admin', password: '' };
const testCollection = '/db/cypress-test-api';
const enc = encodeURIComponent;

// Store a resource via the consolidated raw endpoint: path (+ optional mime) in the
// query string, raw content in the request body. Omit mime to let the server infer
// it from the name; pass a mime (e.g. application/octet-stream) to override. The
// request Content-Type is transport only (octet-stream keeps roaster from parsing
// the body), so the stored mime is driven by &mime / name-inference, not transport.
// `extra` merges into the cy.request options (e.g. { failOnStatusCode: false }).
function store(path, content, mime, extra) {
  return cy.request(Object.assign({
    url: `/api/db/resource?path=${enc(path)}` + (mime ? `&mime=${enc(mime)}` : ''),
    method: 'PUT', auth,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content
  }, extra || {}));
}

describe('/api/db', () => {
  before(() => {
    // Ensure clean state
    cy.request({
      url: `/api/db/collection?path=${testCollection}&force=true`,
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    });
  });

  after(() => {
    cy.request({
      url: `/api/db/collection?path=${testCollection}&force=true`,
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    });
  });

  describe('GET /api/db — list collections', () => {
    it('lists /db root', () => {
      cy.request({ url: '/api/db?path=/db', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body.type).to.eq('collection');
        expect(response.body.path).to.eq('/db');
        expect(response.body.children).to.be.an('array');
        expect(response.body).to.have.property('mode');
        expect(response.body).to.have.property('owner');
      });
    });

    it('returns error for nonexistent collection', () => {
      cy.request({ url: '/api/db?path=/db/nonexistent-xyz', auth, failOnStatusCode: false }).then(response => {
        expect(response.status).to.eq(404);
        expect(response.body).to.have.property('error');
      });
    });

    it('supports glob filter', () => {
      cy.request({
        url: '/api/db?path=/db/apps/existdb-openapi/modules&glob=*.xqm',
        auth
      }).then(response => {
        const resources = response.body.children.filter(c => c.type === 'resource');
        resources.forEach(r => {
          expect(r.name).to.match(/\.xqm$/);
        });
      });
    });

    it('supports recursive listing', () => {
      cy.request({
        url: '/api/db?path=/db/apps/existdb-openapi&recursive=true&depth=1',
        auth
      }).then(response => {
        const collections = response.body.children.filter(c => c.type === 'collection');
        expect(collections.length).to.be.greaterThan(0);
      });
    });

    it('carries an accessible flag on listed children', () => {
      cy.request({ url: '/api/db?path=/db', auth }).then(response => {
        expect(response.status).to.eq(200);
        response.body.children.forEach(c => {
          expect(c).to.have.property('accessible');
          expect(c.accessible).to.be.a('boolean');
        });
      });
    });

    // Regression: one child whose permissions the caller can't read must not 500
    // the whole collection. As guest, /db/system has world-readable config/repo
    // (rwxr-xr-x) plus security (rwxrwx---, guest outside owner/group) which guest
    // can't even retrieve permissions for. The listing must still return 200 with
    // the readable children, and security as a degraded entry flagged inaccessible.
    it('tolerates an unreadable child instead of 500ing the collection (guest)', () => {
      const guest = { username: 'guest', password: 'guest' };
      cy.request({ url: '/api/db?path=/db/system', auth: guest, failOnStatusCode: false })
        .then(response => {
          expect(response.status).to.eq(200);
          const byName = Object.fromEntries(response.body.children.map(c => [c.name, c]));
          // the locked child still appears, flagged inaccessible
          expect(byName).to.have.property('security');
          expect(byName.security.accessible).to.eq(false);
          // the world-readable siblings are listed and accessible
          expect(byName).to.have.property('config');
          expect(byName.config.accessible).to.eq(true);
        });
    });
  });

  describe('POST /api/db/collection — create', () => {
    it('creates a collection', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: testCollection }
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
        expect(response.body).to.have.property('created');
      });
    });

    it('verifies collection exists', () => {
      cy.request({ url: `/api/db?path=${testCollection}`, auth }).then(response => {
        expect(response.body.type).to.eq('collection');
        expect(response.body.path).to.eq(testCollection);
      });
    });

    it('strict (default): a missing parent is a clean 409', () => {
      cy.request({
        url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false,
        body: { path: `${testCollection}/no-such-parent/child` }
      }).then(response => {
        expect(response.status).to.eq(409);
        expect(response.body).to.have.property('error');
      });
    });

    it('recursive:true creates missing ancestor collections (mkdir -p)', () => {
      const deep = `${testCollection}/a/b/c`;
      cy.request({
        url: '/api/db/collection', method: 'POST', auth,
        body: { path: deep, recursive: true }
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
      });
      // every level now exists
      cy.request({ url: `/api/db?path=${enc(`${testCollection}/a/b`)}`, auth }).then(r => {
        expect(r.body.type).to.eq('collection');
      });
      cy.request({ url: `/api/db?path=${enc(deep)}`, auth }).then(r => {
        expect(r.body.type).to.eq('collection');
      });
    });
  });

  describe('PUT /api/db/resource — store', () => {
    it('stores an XML resource with explicit mime', () => {
      store(`${testCollection}/test.xml`, '<root><msg>hello</msg></root>', 'application/xml').then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
        expect(response.body).to.have.property('path', `${testCollection}/test.xml`);
      });
    });

    // Regression: prior to this fix the handler defaulted the mime to
    // "application/xml" when the client omitted it, so .xq / .xqm / .svg / .json
    // content either failed the XML parse outright (XPST0003, "Content is not
    // allowed in prolog") or stored with the wrong MIME. The fix drops the default
    // and lets the 3-arg xmldb:store consult eXist's MimeTable to pick the right
    // MIME from the extension (mime omitted on the wire = the &mime param absent).
    it('auto-detects application/xquery from .xq extension when mime omitted', () => {
      store(`${testCollection}/auto.xq`, 'xquery version "3.1"; 1+1').then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
        expect(response.body).to.have.property('path');
      });
      cy.request({ url: `/api/db/properties?path=${testCollection}/auto.xq`, auth }).then(response => {
        expect(response.body['mime-type']).to.equal('application/xquery');
      });
    });

    it('auto-detects application/xquery from .xqm extension when mime omitted', () => {
      store(`${testCollection}/auto.xqm`, 'xquery version "3.1"; module namespace t = "http://example.com/t";')
        .then(response => expect(response.status).to.be.oneOf([200, 201]));
      cy.request({ url: `/api/db/properties?path=${testCollection}/auto.xqm`, auth }).then(response => {
        expect(response.body['mime-type']).to.equal('application/xquery');
      });
    });

    it('auto-detects image/svg+xml from .svg extension when mime omitted', () => {
      store(`${testCollection}/auto.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      cy.request({ url: `/api/db/properties?path=${testCollection}/auto.svg`, auth }).then(response => {
        expect(response.body['mime-type']).to.equal('image/svg+xml');
      });
    });

    it('auto-detects application/json from .json extension when mime omitted', () => {
      store(`${testCollection}/auto.json`, '{"hello":"world"}');
      cy.request({ url: `/api/db/properties?path=${testCollection}/auto.json`, auth }).then(response => {
        expect(response.body['mime-type']).to.equal('application/json');
      });
    });

    it('stores well-formed .html as text/html via auto-detection', () => {
      store(`${testCollection}/wellformed.html`, '<html><head><title>t</title></head><body><p>x</p></body></html>')
        .then(response => expect(response.status).to.be.oneOf([200, 201]));
      cy.request({ url: `/api/db/properties?path=${testCollection}/wellformed.html`, auth }).then(response => {
        expect(response.body['mime-type']).to.equal('text/html');
      });
    });

    it('returns 400 with a parse-error message for unparseable XML content', () => {
      // Unclosed <img> — not well-formed XML. eXist's text/html is an XML-class
      // mime, so the parser runs and rejects. Clients who need to preserve raw bytes
      // send mime=application/octet-stream explicitly (next test).
      store(`${testCollection}/bad.html`, '<html><body><img src="x.png"></body></html>', null, { failOnStatusCode: false })
        .then(response => {
          expect(response.status).to.equal(400);
          expect(response.body.error).to.match(/parser|XML|img/i);
        });
    });

    it('preserves raw bytes for unparseable content when mime=application/octet-stream', () => {
      store(`${testCollection}/raw.html`, '<html><body><img src="x.png"></body></html>', 'application/octet-stream')
        .then(response => expect(response.status).to.be.oneOf([200, 201]));
      cy.request({ url: `/api/db/properties?path=${testCollection}/raw.html`, auth }).then(response => {
        expect(response.body['mime-type']).to.equal('application/octet-stream');
      });
    });

    it('still honors an explicit mime override (e.g. xhtml+xml for an .html path)', () => {
      store(`${testCollection}/explicit.html`,
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>x</p></body></html>',
        'application/xhtml+xml');
      cy.request({ url: `/api/db/properties?path=${testCollection}/explicit.html`, auth }).then(response => {
        expect(response.body['mime-type']).to.equal('application/xhtml+xml');
      });
    });

    it('400 when path is missing', () => {
      cy.request({ url: '/api/db/resource', method: 'PUT', auth, failOnStatusCode: false, body: 'x' })
        .then(response => expect(response.status).to.eq(400));
    });
  });

  describe('GET /api/db/resource — read', () => {
    it('reads back the stored resource as raw content', () => {
      cy.request({ url: `/api/db/resource?path=${testCollection}/test.xml`, auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.headers['content-type']).to.contain('application/xml');
        expect(response.body).to.include('<msg>hello</msg>');
      });
    });

    it('returns error for nonexistent resource', () => {
      cy.request({
        url: `/api/db/resource?path=${testCollection}/nonexistent.xml`,
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(404);
        expect(response.body).to.have.property('error');
      });
    });
  });

  describe('GET /api/db/properties', () => {
    it('returns resource properties', () => {
      cy.request({ url: `/api/db/properties?path=${testCollection}/test.xml`, auth }).then(response => {
        expect(response.body.type).to.eq('resource');
        expect(response.body).to.have.property('owner');
        expect(response.body).to.have.property('mode');
        expect(response.body).to.have.property('size');
      });
    });

    it('returns collection properties', () => {
      cy.request({ url: `/api/db/properties?path=${testCollection}`, auth }).then(response => {
        expect(response.body.type).to.eq('collection');
        expect(response.body).to.have.property('owner');
      });
    });
  });

  describe('POST /api/db/permissions', () => {
    // Dedicated resource so these tests don't perturb (or get perturbed by)
    // earlier permissions tweaks on /test.xml above.
    const permResource = `${testCollection}/perm.xml`;
    const permSubCollection = `${testCollection}/perm-sub`;

    before(() => {
      // Resource for resource-permission tests (raw store; the consolidated PUT takes
      // the path as a query param + raw body, not a JSON envelope)
      store(permResource, '<r/>', 'application/xml');
      // Sub-collection for collection-permission tests
      cy.request({
        url: '/api/db/collection', method: 'POST', auth,
        body: { path: permSubCollection }
      });
    });

    it('changes mode on a resource (rwxrwxrwx-style)', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, mode: 'rw-rw-r--' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('updated', permResource);
      });

      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.mode).to.eq('rw-rw-r--');
        });
    });

    it('changes owner on a resource', () => {
      // admin → guest, then back to admin so later tests aren't affected
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, owner: 'guest' }
      }).then(response => {
        expect(response.body).to.have.property('updated');
      });
      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.owner).to.eq('guest');
        });

      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, owner: 'admin' }
      });
    });

    it('changes group on a resource', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, group: 'guest' }
      });
      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.group).to.eq('guest');
        });

      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, group: 'dba' }
      });
    });

    it('applies owner + group + mode in a single request', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: {
          path: permResource,
          owner: 'guest', group: 'guest', mode: 'rw-r-----'
        }
      }).then(response => {
        expect(response.status).to.eq(200);
      });

      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.owner).to.eq('guest');
          expect(response.body.group).to.eq('guest');
          expect(response.body.mode).to.eq('rw-r-----');
        });

      // Restore
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, owner: 'admin', group: 'dba', mode: 'rw-rw-r--' }
      });
    });

    it('changes mode on a collection', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permSubCollection, mode: 'rwxr-x---' }
      }).then(response => {
        expect(response.body).to.have.property('updated', permSubCollection);
      });

      cy.request({ url: `/api/db/properties?path=${permSubCollection}`, auth })
        .then(response => {
          expect(response.body.type).to.eq('collection');
          expect(response.body.mode).to.eq('rwxr-x---');
        });
    });

    it('rejects octal mode strings (sm:chmod does not accept them)', () => {
      // Documenting the contract: sm:chmod only accepts the symbolic
      // rwxrwxrwx-style and relative forms (u+x, g-w, etc.) — NOT octal
      // strings like "0644" or "644". Clients that want to send a numeric
      // mode must convert it to the rwxrwxrwx form first.
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, mode: '0644' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.be.at.least(400);
        const body = response.body;
        const msg = (body.description || body.error || '').toLowerCase();
        expect(msg).to.match(/mode|syntax/);
      });
    });

    it('returns HTTP 400 when path is missing', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { mode: 'rw-rw-r--' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.match(/path/i);
      });
    });

    it('returns an error for a nonexistent path', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: '/db/does-not-exist-xyz.xml', mode: 'rw-rw-r--' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.be.at.least(400);
        const body = response.body;
        expect(body.description || body.error).to.exist;
      });
    });
  });

  describe('POST /api/db/copy', () => {
    it('copies a resource into an existing collection (parent only, leaf preserved)', () => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/sub` } });

      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, parent: `${testCollection}/sub` }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/sub/test.xml`);
      });

      cy.request({ url: `/api/db/resource?path=${testCollection}/sub/test.xml`, auth }).then(response => {
        expect(response.body).to.include('<msg>hello</msg>');
      });
    });

    it('copies a resource into an existing collection with a new name (parent + name)', () => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/copy-rename` } });
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: {
          source: `${testCollection}/test.xml`,
          parent: `${testCollection}/copy-rename`,
          name: 'test-renamed.xml'
        }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/copy-rename/test-renamed.xml`);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/copy-rename/test-renamed.xml`, auth }).then(response => {
        expect(response.body).to.include('<msg>hello</msg>');
      });
    });

    it('duplicates a resource in place via newName (shortcut)', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, newName: 'test-dup.xml' }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/test-dup.xml`);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/test-dup.xml`, auth }).then(response => {
        expect(response.body).to.include('<msg>hello</msg>');
      });
    });

    it('duplicates a collection in place via newName (shortcut)', () => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/coll-to-dup` } });
      store(`${testCollection}/coll-to-dup/child.xml`, '<child>hi</child>', 'application/xml');
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/coll-to-dup`, newName: 'coll-duplicated' }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/coll-duplicated`);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/coll-duplicated/child.xml`, auth }).then(response => {
        expect(response.body).to.include('<child>hi</child>');
      });
    });

    it('rejects copy when both parent and newName are missing', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/parent or newName/i);
      });
    });

    it('rejects copy when parent does not exist', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, parent: `${testCollection}/no-such-collection` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/does not exist/i);
      });
    });

    it('rejects copy when destination matches source (no-op collision)', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, parent: testCollection },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/matches source|new name/i);
      });
    });
  });

  describe('POST /api/db/move', () => {
    it('moves a resource into an existing collection (parent only, leaf preserved)', () => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/dest-coll` } });
      store(`${testCollection}/in-dest.xml`, '<msg>moveme</msg>', 'application/xml');
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/in-dest.xml`, parent: `${testCollection}/dest-coll` }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/dest-coll/in-dest.xml`);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/dest-coll/in-dest.xml`, auth }).then(response => {
        expect(response.body).to.include('<msg>moveme</msg>');
      });
    });

    it('moves a resource with rename (parent + name)', () => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/moved` } });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: {
          source: `${testCollection}/sub/test.xml`,
          parent: `${testCollection}/moved`,
          name: 'arrived.xml'
        }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/moved/arrived.xml`);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/moved/arrived.xml`, auth }).then(response => {
        expect(response.body).to.include('<msg>hello</msg>');
      });
    });

    it('renames a resource in place via newName (shortcut)', () => {
      store(`${testCollection}/to-rename.xml`, '<msg>rename me</msg>', 'application/xml');
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/to-rename.xml`, newName: 'renamed.xml' }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/renamed.xml`);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/renamed.xml`, auth }).then(response => {
        expect(response.body).to.include('<msg>rename me</msg>');
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/to-rename.xml`,
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(404);
      });
    });

    it('renames a collection in place via newName (shortcut)', () => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/coll-old` } });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/coll-old`, newName: 'coll-new' }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/coll-new`);
      });
    });

    it('rejects move when both parent and newName are missing', () => {
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/parent or newName/i);
      });
    });

    it('rejects move when parent does not exist', () => {
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, parent: `${testCollection}/no-such-collection` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/does not exist/i);
      });
    });

    // Closes #37 — was the original silent-data-loss case.
    it('refuses to overwrite an existing destination on move (409 Conflict, source preserved)', () => {
      store(`${testCollection}/src-overwrite.xml`, '<src/>', 'application/xml');
      store(`${testCollection}/dest-blocking.xml`, '<dest>existing</dest>', 'application/xml');
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/src-overwrite.xml`, parent: testCollection, name: 'dest-blocking.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(409);
        expect(response.body.error).to.match(/already exists/i);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/src-overwrite.xml`, auth }).then(response => {
        expect(response.body).to.include('<src/>');
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/dest-blocking.xml`, auth }).then(response => {
        expect(response.body).to.include('<dest>existing</dest>');
      });
    });

    it('refuses to overwrite an existing destination collection on move (409 Conflict)', () => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/coll-src-overwrite` } });
      cy.request({ url: '/api/db/collection', method: 'POST', auth, body: { path: `${testCollection}/coll-dest-blocking` } });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/coll-src-overwrite`, parent: testCollection, name: 'coll-dest-blocking' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(409);
        expect(response.body.error).to.match(/already exists/i);
      });
      cy.request({ url: `/api/db?path=${testCollection}/coll-src-overwrite`, auth }).then(response => {
        expect(response.body.type).to.equal('collection');
      });
      cy.request({ url: `/api/db?path=${testCollection}/coll-dest-blocking`, auth }).then(response => {
        expect(response.body.type).to.equal('collection');
      });
    });

    it('rejects move when source does not exist (404)', () => {
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/no-such-source.xml`, parent: testCollection, name: 'irrelevant.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(404);
        expect(response.body.error).to.match(/not found/i);
      });
    });
  });

  describe('POST /api/db/copy — safety', () => {
    it('refuses to overwrite an existing destination on copy (409 Conflict, both preserved)', () => {
      store(`${testCollection}/copy-src.xml`, '<src/>', 'application/xml');
      store(`${testCollection}/copy-dest-blocking.xml`, '<dest/>', 'application/xml');
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/copy-src.xml`, parent: testCollection, name: 'copy-dest-blocking.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(409);
        expect(response.body.error).to.match(/already exists/i);
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/copy-src.xml`, auth }).then(response => {
        expect(response.body).to.include('<src/>');
      });
      cy.request({ url: `/api/db/resource?path=${testCollection}/copy-dest-blocking.xml`, auth }).then(response => {
        expect(response.body).to.include('<dest/>');
      });
    });

    it('rejects copy when source does not exist (404)', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/no-such-source.xml`, parent: testCollection, name: 'x.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(404);
        expect(response.body.error).to.match(/not found/i);
      });
    });
  });

  describe('DELETE /api/db/resource', () => {
    it('removes a resource', () => {
      cy.request({
        url: `/api/db/resource?path=${testCollection}/test.xml`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('removed');
      });
    });

    it('returns error for nonexistent resource', () => {
      cy.request({
        url: `/api/db/resource?path=${testCollection}/nonexistent.xml`,
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(404);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('not found');
      });
    });

    it('refuses to delete protected paths', () => {
      cy.request({
        url: '/api/db/resource?path=/db/system/config',
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(403);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('protected');
      });
    });
  });

  describe('DELETE /api/db/collection', () => {
    it('refuses non-empty collection without force', () => {
      cy.request({
        url: `/api/db/collection?path=${testCollection}`,
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(409);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('not empty');
      });
    });

    it('removes non-empty collection with force', () => {
      cy.request({
        url: `/api/db/collection?path=${testCollection}&force=true`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('removed');
      });
    });
  });

  // Raw binary-safe transport on the consolidated endpoint: a binary body round-trips
  // intact (no base64 mangling), an XML/text resource returns its serialized source
  // (NOT execution output), and download=true sets Content-Disposition: attachment.
  describe('GET/PUT /api/db/resource — raw transport', () => {
    const coll = `${testCollection}/raw`;
    // recursive:true so this block is self-sufficient — the DELETE /api/db/collection
    // block above removes testCollection, so the parent may not exist here.
    before(() => cy.request({ url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false, body: { path: coll, recursive: true } }));

    it('PUT then GET round-trips raw binary content (not base64-mangled)', () => {
      const content = 'raw-bytes-not-b64-payload';
      store(`${coll}/blob.bin`, content).then(r => expect(r.status).to.be.oneOf([200, 201]));
      cy.request({ url: `/api/db/resource?path=${enc(`${coll}/blob.bin`)}`, auth }).then(r => {
        expect(r.status).to.eq(200);
        expect(r.body).to.eq(content);
      });
    });

    it('returns an XQuery resource as source, not execution output', () => {
      store(`${coll}/mod.xq`, 'xquery version "3.1"; 40 + 2', 'application/xquery');
      cy.request({ url: `/api/db/resource?path=${enc(`${coll}/mod.xq`)}`, auth }).then(r => {
        expect(r.body).to.contain('xquery version');
        expect(String(r.body)).to.not.eq('42');
      });
    });

    it('download=true sets Content-Disposition: attachment', () => {
      store(`${coll}/dl.bin`, 'data');
      cy.request({ url: `/api/db/resource?path=${enc(`${coll}/dl.bin`)}&download=true`, auth }).then(r => {
        expect(r.headers['content-disposition']).to.match(/^attachment/);
      });
    });
  });

  describe('awkward resource names (encode/decode boundary)', () => {
    // The API speaks DECODED UTF-8 on the wire both ways: a client sends/receives
    // "café déjà.xml", never "caf%C3%A9...". eXist stores names percent-encoded,
    // so db-core encodes on input and decodes on output. The other db tests use
    // ASCII names and so don't exercise this boundary.
    // non-ASCII + space; sub-delim apostrophe (xmldb:store leaves it literal); literal "+"
    // (must survive: stored as a literal "+", decoded back to "+", NOT form-decoded to a space)
    const NAMES = ['café déjà.xml', "o'brien.xml", 'naïve+test.xml'];

    before(() => {
      cy.request({
        url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false,
        body: { path: testCollection }
      });
    });

    NAMES.forEach(name => {
      const path = `${testCollection}/${name}`;
      const q = encodeURIComponent(path);

      it(`stores, reads, lists and removes a resource named "${name}" by its decoded name`, () => {
        // store with the decoded name
        store(path, `<doc>${name}</doc>`, 'application/xml').then(r => expect(r.status).to.be.oneOf([200, 201]));

        // read back BY the decoded name: content intact
        cy.request({ url: `/api/db/resource?path=${q}`, auth }).then(r => {
          expect(r.body).to.include(name);
        });

        // listing shows the decoded name (not percent-encoded)
        cy.request({ url: `/api/db?path=${encodeURIComponent(testCollection)}`, auth }).then(r => {
          const names = r.body.children.map(c => c.name);
          expect(names, 'decoded name appears in listing').to.include(name);
          names.forEach(n =>
            expect(n, 'listing names are decoded, not percent-encoded').to.not.match(/%[0-9A-Fa-f]{2}/)
          );
        });

        // remove BY the decoded name
        cy.request({ url: `/api/db/resource?path=${q}`, method: 'DELETE', auth }).then(r => {
          expect(r.status).to.be.oneOf([200, 204]);
        });
      });
    });
  });

  // Serialization parameters on GET /api/db/resource (existdb-openapi#48, extended
  // here to the full W3C set + eXist extensions). XML/text resources honor the
  // params; omitted params defer to conf.xml defaults. The GET body is the raw
  // serialized content (Content-Type = the stored mime).
  describe('GET /api/db/resource — serialization parameters (existdb-oxygen-plugin / #48)', () => {
    const serDoc = `${testCollection}/ser.xml`;

    before(() => store(serDoc, '<root><a>1</a><b>2</b></root>', 'application/xml'));

    it('no serialization params → the conf.xml default (backward compatible)', () => {
      cy.request({ url: `/api/db/resource?path=${serDoc}`, auth }).then(response => {
        expect(response.body).to.contain('<a>1</a>');
      });
    });

    it('indent=yes pretty-prints', () => {
      cy.request({ url: `/api/db/resource?path=${serDoc}&indent=yes`, auth }).then(response => {
        expect(response.body).to.match(/<root>\s*\n\s+<a>1<\/a>/);
      });
    });

    it('indent=no does not pretty-print', () => {
      cy.request({ url: `/api/db/resource?path=${serDoc}&indent=no`, auth }).then(response => {
        expect(response.body).to.eq('<root><a>1</a><b>2</b></root>');
      });
    });

    it('indent=true is treated as yes', () => {
      cy.request({ url: `/api/db/resource?path=${serDoc}&indent=true`, auth }).then(response => {
        expect(response.body).to.match(/<a>1<\/a>/);
        expect(response.body).to.include('\n');
      });
    });

    it('indent=false is treated as no', () => {
      cy.request({ url: `/api/db/resource?path=${serDoc}&indent=false`, auth }).then(response => {
        expect(response.body).to.eq('<root><a>1</a><b>2</b></root>');
      });
    });

    it('omit-xml-declaration=no includes the XML declaration', () => {
      cy.request({ url: `/api/db/resource?path=${serDoc}&omit-xml-declaration=no`, auth }).then(response => {
        expect(response.body).to.match(/^<\?xml /);
      });
    });

    it('omit-xml-declaration=yes omits the XML declaration', () => {
      cy.request({ url: `/api/db/resource?path=${serDoc}&omit-xml-declaration=yes`, auth }).then(response => {
        expect(response.body).to.not.match(/^<\?xml /);
      });
    });

    it('exist.expand-xincludes=no preserves <xi:include>; =yes expands it (eXist serializer extension, no #6447)', () => {
      // expand-xincludes is an eXist serializer extension, so it is namespaced on the
      // wire with the exist. prefix (the W3C params like indent stay unprefixed). It is
      // emitted in the exist: serialization namespace, which eXist honors natively via
      // fn:serialize — so this works on any eXist without eXist-db/exist#6447. The =no
      // case is the data-loss-safe read: a round-trip (open with =no, save) keeps the
      // includes literal instead of expand-and-destroy.
      const target = `${testCollection}/xi-target.xml`;
      const including = `${testCollection}/xi-including.xml`;
      store(target, '<para>included</para>', 'application/xml');
      store(including,
        '<doc xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="xi-target.xml"/></doc>',
        'application/xml');

      cy.request({ url: `/api/db/resource?path=${including}&exist.expand-xincludes=no`, auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.contain('<xi:include');
        expect(response.body).to.not.contain('included');
      });

      cy.request({ url: `/api/db/resource?path=${including}&exist.expand-xincludes=yes`, auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.contain('<para>included</para>');
        expect(response.body).to.not.contain('<xi:include');
      });
    });
  });

  // Gap features folded into db-core (audit §2 items 3 & 5): a writable flag and
  // mime-type on list items, and start/count pagination. (Item 4 set-MIME via
  // /permissions is also covered.)
  describe('db-core gap features (audit §2 items 3–5)', () => {
    const gaps = `${testCollection}/gaps`;

    before(() => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false, body: { path: testCollection } });
      cy.request({ url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false, body: { path: gaps } });
      ['a.xml', 'b.xml', 'c.xml'].forEach(n => store(`${gaps}/${n}`, '<doc/>', 'application/xml'));
    });

    after(() => {
      cy.request({ url: `/api/db/collection?path=${enc(gaps)}&force=true`, method: 'DELETE', auth, failOnStatusCode: false });
    });

    it('item 3 — every list item carries a writable boolean; resources carry mime-type', () => {
      cy.request({ url: `/api/db?path=${enc(gaps)}`, auth }).then(r => {
        expect(r.body.children).to.have.length.greaterThan(0);
        r.body.children.forEach(c => expect(c.writable, `writable on ${c.name}`).to.be.a('boolean'));
        r.body.children.filter(c => c.type === 'resource').forEach(c =>
          expect(c, `mime-type on ${c.name}`).to.have.property('mime-type').that.is.a('string')
        );
      });
    });

    it('item 5 — flat listing carries total/start/count and the default is all children', () => {
      cy.request({ url: `/api/db?path=${enc(gaps)}`, auth }).then(r => {
        expect(r.body).to.have.property('total', 3);
        expect(r.body).to.have.property('start', 1);
        expect(r.body).to.have.property('count', 3);
        expect(r.body.children).to.have.length(3);
      });
    });

    it('item 5 — start/count slices the child sequence; total stays the full count', () => {
      cy.request({ url: `/api/db?path=${enc(gaps)}&start=2&count=1`, auth }).then(r => {
        expect(r.body.total).to.eq(3);
        expect(r.body.start).to.eq(2);
        expect(r.body.count).to.eq(1);
        expect(r.body.children).to.have.length(1);
        expect(r.body.children[0].name).to.eq('b.xml');
      });
    });

    it('item 4 — set MIME type via POST /api/db/permissions (compatible class)', () => {
      // a.xml is stored as XML, so a compatible (XML-class) mime is accepted
      const path = `${gaps}/a.xml`;
      cy.request({ url: '/api/db/permissions', method: 'POST', auth, body: { path, mime: 'text/html' } })
        .then(r => expect(r.status).to.eq(200));
      cy.request({ url: `/api/db/properties?path=${enc(path)}`, auth }).then(r => {
        expect(r.body['mime-type']).to.eq('text/html');
      });
    });

    it('item 4 — a mime incompatible with the resource storage class is a clean 400', () => {
      // eXist forbids a binary-class mime on an XML-stored resource; surface 400, not 500
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth, failOnStatusCode: false,
        body: { path: `${gaps}/b.xml`, mime: 'application/json' }
      }).then(r => {
        expect(r.status).to.eq(400);
        expect(r.body).to.have.property('error');
      });
    });
  });

  // Read-compatibility: a resource an older client stored full-encoded (sub-delim
  // names like it's.xml -> it%27s.xml) stays reachable by its decoded name, because
  // db-core falls back to the legacy stored form when the canonical iri-to-uri form
  // doesn't exist. (New writes still use the canonical form.)
  describe('read-compat for legacy full-encoded names', () => {
    const rc = `${testCollection}/rc`;
    function runAdmin(query) {
      return cy.request({ url: '/api/query', method: 'POST', auth, body: { query } }).then(r => {
        if (r.body && r.body.cursor) cy.request({ url: `/api/query/${r.body.cursor}`, method: 'DELETE', auth, failOnStatusCode: false });
      });
    }
    before(() => {
      // store "it's.xml" the OLD way (full-encoded -> it%27s.xml), bypassing the API
      runAdmin(`(if (xmldb:collection-available("${testCollection}")) then () else xmldb:create-collection("/db", "${testCollection.replace('/db/', '')}"), xmldb:create-collection("${testCollection}", "rc"), xmldb:store("${rc}", xmldb:encode("it's.xml"), <doc>legacy</doc>), "ok")[last()]`);
    });
    after(() => {
      cy.request({ url: `/api/db/collection?path=${encodeURIComponent(rc)}&force=true`, method: 'DELETE', auth, failOnStatusCode: false });
    });

    it('GET resolves a legacy full-encoded name by its decoded name', () => {
      cy.request({ url: `/api/db/resource?path=${encodeURIComponent(`${rc}/it's.xml`)}`, auth }).then(r => {
        expect(r.status).to.eq(200);
        // consolidated GET returns the raw body (not a {content} envelope)
        expect(r.body).to.contain('legacy');
      });
    });

    it('properties resolves the legacy name too', () => {
      cy.request({ url: `/api/db/properties?path=${encodeURIComponent(`${rc}/it's.xml`)}`, auth }).then(r => {
        expect(r.status).to.eq(200);
        expect(r.body.type).to.eq('resource');
      });
    });
  });
});
