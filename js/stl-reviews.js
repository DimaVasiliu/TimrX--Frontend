(function () {
    'use strict';
  
    // Only add real, approved customer reviews here. Leave packs absent until a
    // genuine review exists so Product structured data never claims fake ratings.
    var REVIEWS_BY_PACK = {
      // Example:
      // 'airplanes': [
      //   {
      //     author: 'Customer name',
      //     rating: 5,
      //     datePublished: '2026-06-06',
      //     body: 'Short review text approved for public display.'
      //   }
      // ]
    };
  
    function cleanReview(review) {
      if (!review) return null;
      var rating = Number(review.rating);
      var author = String(review.author || '').trim();
      var body = String(review.body || '').trim();
      var datePublished = String(review.datePublished || '').trim();
  
      if (!author || !body || !datePublished) return null;
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) return null;
  
      return {
        author: author,
        rating: rating,
        datePublished: datePublished,
        body: body
      };
    }
  
    function get(slug) {
      return (REVIEWS_BY_PACK[slug] || []).map(cleanReview).filter(Boolean);
    }
  
    function summary(slug) {
      var reviews = get(slug);
      if (!reviews.length) return null;
      var total = reviews.reduce(function (sum, review) { return sum + review.rating; }, 0);
      return {
        ratingValue: Math.round((total / reviews.length) * 10) / 10,
        reviewCount: reviews.length
      };
    }
  
    window.STLReviews = {
      byPack: REVIEWS_BY_PACK,
      get: get,
      summary: summary
    };
  })();
  