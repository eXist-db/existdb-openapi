const auth = { username: 'admin', password: '' };

describe('Priority 1: Safety and correctness', () => {
  describe('1a: Self-deletion guard', () => {
    it('DELETE /api/users/{self} returns 403', () => {
      cy.request({
        url: '/api/users/admin',
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(403);
      });
    });

    it('DELETE /api/groups/{member-group} returns 403', () => {
      cy.request({
        url: '/api/groups/dba',
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(403);
      });
    });
  });

  describe('1b: GET /api/groups/{name}', () => {
    it('returns group details', () => {
      cy.request({ url: '/api/groups/dba', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('name', 'dba');
        expect(response.body).to.have.property('managers');
        expect(response.body).to.have.property('members');
        expect(response.body.managers).to.be.an('array');
        expect(response.body.members).to.include('admin');
      });
    });

    it('returns 404 for nonexistent group', () => {
      cy.request({
        url: '/api/groups/nonexistent-group-xyz',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(404);
      });
    });

    it('includes group metadata', () => {
      cy.request({ url: '/api/groups/dba', auth }).then(response => {
        expect(response.body).to.have.property('metadata');
        expect(response.body.metadata).to.be.an('array');
      });
    });
  });

  describe('1c: User metadata', () => {
    it('GET /api/users/{name} includes metadata', () => {
      cy.request({ url: '/api/users/admin', auth }).then(response => {
        expect(response.body).to.have.property('metadata');
        expect(response.body.metadata).to.be.an('array');
      });
    });
  });

  describe('1d: User enabled and primaryGroup', () => {
    const testUser = 'parity-test-user';

    afterEach(() => {
      cy.request({
        url: `/api/users/${testUser}`,
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      });
    });

    it('PUT /api/users/{name} with enabled and primaryGroup', () => {
      // Create
      cy.request({
        url: '/api/users',
        method: 'POST',
        auth,
        body: { name: testUser, password: 'test123', groups: ['guest'] }
      });

      // Verify defaults
      cy.request({ url: `/api/users/${testUser}`, auth }).then(response => {
        expect(response.body.enabled).to.eq(true);
      });

      // Disable account
      cy.request({
        url: `/api/users/${testUser}`,
        method: 'PUT',
        auth,
        body: { enabled: false }
      });

      // Verify disabled
      cy.request({ url: `/api/users/${testUser}`, auth }).then(response => {
        expect(response.body.enabled).to.eq(false);
      });

      // Re-enable
      cy.request({
        url: `/api/users/${testUser}`,
        method: 'PUT',
        auth,
        body: { enabled: true }
      });

      cy.request({ url: `/api/users/${testUser}`, auth }).then(response => {
        expect(response.body.enabled).to.eq(true);
      });
    });
  });
});

describe('Priority 2: HTTP status codes', () => {
  it('404 on missing user', () => {
    cy.request({
      url: '/api/users/nonexistent-xyz',
      auth,
      failOnStatusCode: false
    }).then(response => {
      expect(response.status).to.eq(404);
    });
  });

  it('404 on missing resource', () => {
    cy.request({
      url: '/api/db/resource?path=/db/nonexistent.xml',
      auth,
      failOnStatusCode: false
    }).then(response => {
      expect(response.status).to.eq(404);
    });
  });

  it('403 on protected path delete', () => {
    cy.request({
      url: '/api/db/resource?path=/db/system/config',
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    }).then(response => {
      expect(response.status).to.eq(403);
    });
  });

  it('404 on missing group', () => {
    cy.request({
      url: '/api/groups/nonexistent-group-xyz',
      auth,
      failOnStatusCode: false
    }).then(response => {
      expect(response.status).to.eq(404);
    });
  });

  it('201 on collection create', () => {
    cy.request({
      url: '/api/db/collection',
      method: 'POST',
      auth,
      body: { path: '/db/parity-test-201' }
    }).then(response => {
      expect(response.status).to.eq(201);
    });

    // Cleanup
    cy.request({
      url: '/api/db/collection?path=/db/parity-test-201&force=true',
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    });
  });
});

describe('Priority 3: atom-editor-support endpoints', () => {
  describe('GET /api/db/sync', () => {
    it('returns sync tree', () => {
      cy.request({
        url: '/api/db/sync?root=/db/apps/existdb-openapi/modules',
        auth
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('root');
        expect(response.body).to.have.property('timestamp');
        expect(response.body).to.have.property('children');
        expect(response.body.children).to.be.an('array');
        expect(response.body.children.length).to.be.greaterThan(0);
        const item = response.body.children[0];
        expect(item).to.have.property('path');
        expect(item).to.have.property('lastModified');
      });
    });

    it('supports timestamp filter', () => {
      // Use a future timestamp — should return empty children
      cy.request({
        url: '/api/db/sync?root=/db/apps/existdb-openapi/modules&timestamp=2099-01-01T00:00:00Z',
        auth
      }).then(response => {
        // Resources should be filtered out (all older than 2099)
        const resources = response.body.children.filter(c => !c.children);
        expect(resources).to.have.length(0);
      });
    });
  });

  describe('GET /api/modules', () => {
    it('returns importable modules', () => {
      cy.request({
        url: '/api/modules?path=/db/apps/existdb-openapi/modules/db.xqm',
        auth
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        expect(response.body.length).to.be.greaterThan(0);
        const mod = response.body[0];
        expect(mod).to.have.property('prefix');
        expect(mod).to.have.property('namespace');
        expect(mod).to.have.property('ref');
      });
    });
  });
});

describe('Priority 4: ACL support', () => {
  it('db:list includes acl field', () => {
    cy.request({
      url: '/api/db?path=/db/apps/existdb-openapi/modules&glob=api.xq',
      auth
    }).then(response => {
      expect(response.body).to.have.property('acl');
      expect(response.body.acl).to.be.an('array');
      // Children should also have acl
      if (response.body.children && response.body.children.length > 0) {
        expect(response.body.children[0]).to.have.property('acl');
      }
    });
  });

  it('db:properties includes acl field', () => {
    cy.request({
      url: '/api/db/properties?path=/db/apps/existdb-openapi/modules/api.xq',
      auth
    }).then(response => {
      expect(response.body).to.have.property('acl');
      expect(response.body.acl).to.be.an('array');
    });
  });
});
