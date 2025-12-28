# Reviews Service

Product reviews and Q&A service for the e-commerce platform.

## Features

- **Product Reviews**: Create, manage, and moderate product reviews
- **Review Verification**: Verified purchase badges with order matching
- **Review Images**: Support for review images/media
- **Vendor Responses**: Seller responses to reviews
- **Review Voting**: Helpful/not helpful voting
- **Review Reports**: User-submitted reports for moderation
- **Moderation**: Review moderation workflow with logs
- **Product Q&A**: Customer questions and answers
- **Answer Voting**: Helpful voting on answers
- **Review Stats**: Aggregate product review statistics

## API Endpoints

### Reviews
- `POST /reviews` - Create a review
- `GET /reviews` - List reviews (with filters)
- `GET /reviews/:id` - Get review by ID
- `PUT /reviews/:id` - Update review (author only)
- `DELETE /reviews/:id` - Delete review (author/admin)
- `GET /reviews/product/:productId` - Get reviews for a product
- `GET /reviews/user/:userId` - Get reviews by a user

### Review Images
- `POST /reviews/:id/images` - Add image to review
- `DELETE /reviews/:id/images/:imageId` - Remove image

### Review Voting
- `POST /reviews/:id/vote` - Vote on review
- `DELETE /reviews/:id/vote` - Remove vote

### Review Reports
- `POST /reviews/:id/report` - Report a review
- `GET /reports` - List reports (admin)
- `POST /reports/:id/resolve` - Resolve report

### Vendor Responses
- `POST /reviews/:id/response` - Add vendor response
- `PUT /reviews/:id/response` - Update response
- `DELETE /reviews/:id/response` - Delete response

### Moderation
- `GET /moderation/queue` - Get moderation queue
- `POST /moderation/:id/approve` - Approve review
- `POST /moderation/:id/reject` - Reject review
- `POST /moderation/:id/flag` - Flag for review
- `POST /moderation/:id/remove` - Remove published review
- `POST /moderation/:id/restore` - Restore removed review
- `GET /moderation/:id/logs` - Get moderation logs

### Questions
- `POST /questions` - Create a question
- `GET /questions` - List questions
- `GET /questions/:id` - Get question by ID
- `PUT /questions/:id` - Update question (author only)
- `DELETE /questions/:id` - Delete question (author/admin)
- `GET /questions/product/:productId` - Get questions for a product
- `POST /questions/:id/vote` - Vote on question
- `DELETE /questions/:id/vote` - Remove vote

### Answers
- `POST /questions/:questionId/answers` - Add answer
- `GET /questions/:questionId/answers` - List answers
- `PUT /answers/:id` - Update answer (author only)
- `DELETE /answers/:id` - Delete answer (author/admin)
- `POST /answers/:id/accept` - Accept as best answer
- `POST /answers/:id/vote` - Vote on answer
- `DELETE /answers/:id/vote` - Remove vote

### Stats
- `GET /stats/product/:productId` - Get product review stats
- `POST /stats/product/:productId/recalculate` - Recalculate stats (admin)

## Running the Service

```bash
# Development
pnpm dev

# Production
pnpm build
pnpm start
```

## Environment Variables

- `PORT` - Server port (default: 3009)
- `DATABASE_URL` - PostgreSQL connection string

## Port

This service runs on port `3009`.
