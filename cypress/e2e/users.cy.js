const auth = { username: 'admin', password: '' };

describe('/api/users', () => {
  describe('GET /api/users/whoami', () => {
    it('returns current user identity', () => {
      cy.request({ url: '/api/users/whoami', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body.real).to.have.property('user', 'admin');
        expect(response.body.real.groups).to.include('dba');
        expect(response.body.effective).to.have.property('user', 'admin');
      });
    });
  });

  describe('GET /api/users', () => {
    it('lists all users', () => {
      cy.request({ url: '/api/users', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        const names = response.body.map(u => u.name);
        expect(names).to.include('admin');
        expect(names).to.include('guest');
      });
    });
  });

  describe('user CRUD', () => {
    const testUser = 'cypress-test-user';

    afterEach(() => {
      // Clean up in case test failed mid-way
      cy.request({
        url: `/api/users/${testUser}`,
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      });
    });

    it('creates, reads, updates, and deletes a user', () => {
      // Create
      cy.request({
        url: '/api/users',
        method: 'POST',
        auth,
        body: { name: testUser, password: 'test123' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('created', testUser);
      });

      // Read
      cy.request({
        url: `/api/users/${testUser}`,
        auth
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body.name).to.eq(testUser);
        expect(response.body.enabled).to.eq(true);
      });

      // Update — add to guest group
      cy.request({
        url: `/api/users/${testUser}`,
        method: 'PUT',
        auth,
        body: { groups: ['guest'] }
      }).then(response => {
        expect(response.body).to.have.property('updated', testUser);
      });

      // Verify update
      cy.request({
        url: `/api/users/${testUser}`,
        auth
      }).then(response => {
        expect(response.body.groups).to.include('guest');
      });

      // Change password
      cy.request({
        url: `/api/users/${testUser}`,
        method: 'PUT',
        auth,
        body: { password: 'newpass456' }
      }).then(response => {
        expect(response.body).to.have.property('updated', testUser);
      });

      // Verify new password works
      cy.request({
        url: '/api/users/whoami',
        auth: { username: testUser, password: 'newpass456' }
      }).then(response => {
        expect(response.body.real.user).to.eq(testUser);
      });

      // Delete
      cy.request({
        url: `/api/users/${testUser}`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('removed', testUser);
      });

      // Verify deleted
      cy.request({
        url: `/api/users/${testUser}`,
        auth
      }).then(response => {
        expect(response.body).to.have.property('error');
      });
    });
  });

  describe('GET /api/users/{name} — error path', () => {
    it('returns error for nonexistent user', () => {
      cy.request({
        url: '/api/users/nonexistent-user-xyz',
        auth
      }).then(response => {
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('not found');
      });
    });
  });
});

describe('/api/groups', () => {
  describe('GET /api/groups', () => {
    it('lists all groups', () => {
      cy.request({ url: '/api/groups', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        const names = response.body.map(g => g.name);
        expect(names).to.include('dba');
        expect(names).to.include('guest');
      });
    });
  });

  describe('group CRUD', () => {
    const testGroup = 'cypress-test-group';

    afterEach(() => {
      cy.request({
        url: `/api/groups/${testGroup}`,
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      });
    });

    it('creates and deletes a group', () => {
      cy.request({
        url: '/api/groups',
        method: 'POST',
        auth,
        body: { name: testGroup }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('created', testGroup);
      });

      cy.request({
        url: `/api/groups/${testGroup}`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('removed', testGroup);
      });
    });
  });
});
